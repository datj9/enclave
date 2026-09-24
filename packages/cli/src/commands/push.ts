import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  assertBundlePushable,
  collectBundle,
  findDeadLinks,
  InvalidHostError,
  normaliseHost,
  push,
  PushError,
} from '../../../push-core/src/index.ts'
import type {
  CollectResult,
  DeadLink,
  PushResult,
  SkippedFile,
  UploadPlan,
} from '../../../push-core/src/index.ts'
import type { Visibility } from '../../../push-core/src/types.ts'
import { apiClient } from '../api-client.ts'
import { requireToken } from '../auth.ts'
import { CliError, reportFailure } from '../errors.ts'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit-codes.ts'
import { InvalidIdError, resolveArtifactId, shortId } from '../ids.ts'
import {
  messageOf,
  printDiagnostic,
  printJson,
  printLine,
  skipReasonText,
  type CliContext,
} from '../output.ts'
import { legacyStatePath, readState, statePath, writeState } from '../state.ts'
import type { ProjectState } from '../state.ts'
import { USER_AGENT } from '../version.ts'

export interface PushCommandOptions {
  readonly directory: string
  readonly host?: string
  readonly title?: string
  readonly visibility?: Visibility
  readonly isNew: boolean
  readonly isForced: boolean
  /** A full uuid or an unambiguous prefix. Names the artifact to append to when the directory
   *  carries no state file — a fresh CI checkout, or a build step that wiped it. */
  readonly artifactRef?: string
  readonly isDryRun: boolean
  readonly isJson: boolean
  readonly isInsecureAllowed?: boolean
}

const BYTES_PER_KILOBYTE = 1024

function writeSkippedBlock(ctx: CliContext, skipped: readonly SkippedFile[]): void {
  if (skipped.length === 0) return
  // `reduce`, not `Math.max(...paths)`: the list is unbounded and a spread can blow the argument
  // limit on a large tree.
  const pathColumnWidth = skipped.reduce((widest, file) => Math.max(widest, file.path.length), 0)
  printLine(ctx, `skipped ${String(skipped.length)} files:`)
  for (const file of skipped) {
    printLine(ctx, `  ${file.path.padEnd(pathColumnWidth)}  ${skipReasonText(file)}`)
  }
}

/**
 * Advice, not a refusal: the artifact origin 404s an unmatched path with a page that names
 * nothing, so a link the bundle cannot satisfy is worth saying out loud before it ships. stderr,
 * never stdout — stdout carries the result contract. Same `reduce` pattern as writeSkippedBlock.
 */
function writeDeadLinkBlock(ctx: CliContext, deadLinks: readonly DeadLink[]): void {
  if (deadLinks.length === 0) return
  const fromColumnWidth = deadLinks.reduce((widest, link) => Math.max(widest, link.from.length), 0)
  const count = deadLinks.length
  printDiagnostic(
    ctx,
    count === 1
      ? 'warning: 1 link points at a file not in this bundle:'
      : `warning: ${String(count)} links point at files not in this bundle:`,
  )
  for (const link of deadLinks) {
    printDiagnostic(ctx, `  ${link.from.padEnd(fromColumnWidth)} → ${link.to}`)
  }
}

function kilobytesOf(directory: string, paths: readonly string[]): number {
  const totalBytes = paths.reduce(
    (runningTotal, path) => runningTotal + statSync(join(directory, path)).size,
    0,
  )
  return Math.round(totalBytes / BYTES_PER_KILOBYTE)
}

/**
 * Checked before anything else reads the path: `collectBundle` throws a raw fs error from outside
 * every `--json` branch, and the catch that would label it belongs to the network push — which is
 * how a missing directory came to be reported as `UNEXPECTED_RESPONSE`.
 */
function refuseUnusableDirectory(options: PushCommandOptions): void {
  if (!existsSync(options.directory)) {
    throw new CliError('DIRECTORY_NOT_FOUND', `no such directory: ${options.directory}`, {
      exitCode: EXIT_USAGE,
    })
  }
  if (!statSync(options.directory).isDirectory()) {
    throw new CliError(
      'NOT_A_DIRECTORY',
      `${options.directory} is a file — push takes the directory that holds index.html`,
      { exitCode: EXIT_USAGE },
    )
  }
}

/**
 * `refuseUnusableDirectory` catches a missing or non-directory path; what is left is a file that
 * exists and cannot be read — mode 000, or deleted between the walk and the read. That throw used
 * to reach the network catch, which is the whole reason `--json` once reported a local fs failure
 * as `UNEXPECTED_RESPONSE`; escaping `runPush` entirely is worse, because then stderr carries a
 * bare line instead of the error object `--json` promises.
 */
function collectOrRefuse(options: PushCommandOptions): CollectResult {
  try {
    return collectBundle(options.directory)
  } catch (error) {
    throw new CliError('UNREADABLE_DIRECTORY', messageOf(error))
  }
}

/** A state file no longer refuses the push — it directs it at the artifact it names — but it must
 *  still agree on host. */
function refuseMismatchedHost(
  state: ProjectState | null,
  host: string,
  options: PushCommandOptions,
): void {
  if (state === null || options.isNew) return

  let stateHost: string
  try {
    stateHost = normaliseHost(state.host, options.isInsecureAllowed ?? false)
  } catch {
    // resolveHost already refused an unnormalisable host the push was relying on, so reaching here
    // means --host or ENCLAVE_HOST won and the state simply describes a different instance.
    throw new CliError('HOST_MISMATCH', `state file targets '${state.host}', not ${host}`)
  }

  if (stateHost !== host) {
    throw new CliError('HOST_MISMATCH', `state file targets ${stateHost}, not ${host}`)
  }
}

type HostSource = 'flag' | 'environment' | 'state'

/** The single place push's host precedence is written down — `resolveHost` reads the winning
 *  source from here rather than re-deriving it and drifting. */
function hostCandidate(
  state: ProjectState | null,
  options: PushCommandOptions,
  ctx: CliContext,
): { readonly value: string; readonly source: HostSource } | null {
  if (options.host !== undefined && options.host !== '') {
    return { value: options.host, source: 'flag' }
  }
  const fromEnvironment = ctx.env['ENCLAVE_HOST']
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return { value: fromEnvironment, source: 'environment' }
  }
  if (state !== null && state.host !== '') return { value: state.host, source: 'state' }
  return null
}

function resolveHost(
  state: ProjectState | null,
  options: PushCommandOptions,
  ctx: CliContext,
): string {
  const candidate = hostCandidate(state, options, ctx)
  if (candidate === null) {
    throw new CliError('NO_HOST', 'no host: pass --host or set ENCLAVE_HOST', {
      exitCode: EXIT_USAGE,
    })
  }

  try {
    return normaliseHost(candidate.value, options.isInsecureAllowed ?? false)
  } catch (error) {
    const reason = error instanceof InvalidHostError ? error.message : 'invalid host'
    // A host that came from the state file appears nowhere on the command line, so naming the file
    // is the whole diagnosis — and an unusable file is a failure, not a malformed invocation.
    if (candidate.source === 'state') {
      throw new CliError(
        'INVALID_STATE',
        `${statePath(options.directory)} has an invalid host '${candidate.value}': ${reason}`,
      )
    }
    throw new CliError('INVALID_HOST', reason, { exitCode: EXIT_USAGE })
  }
}

/** A non-PushError out of push-core is a response it could not make sense of. */
function asPushError(error: unknown): PushError | CliError {
  return error instanceof PushError ? error : new CliError('UNEXPECTED_RESPONSE', messageOf(error))
}

function reportDryRun(options: PushCommandOptions, ctx: CliContext): ExitCode {
  const bundle = collectOrRefuse(options)

  try {
    assertBundlePushable(bundle.files, bundle.skipped)
  } catch (error) {
    throw asPushError(error)
  }

  const uploaded = bundle.files.map((file) => file.path)
  const deadLinks = findDeadLinks(bundle.files)

  if (options.isJson) {
    printJson(ctx, { uploaded, skipped: bundle.skipped, deadLinks })
    return EXIT_OK
  }

  writeDeadLinkBlock(ctx, deadLinks)
  writeSkippedBlock(ctx, bundle.skipped)
  printLine(
    ctx,
    `✓ ${String(uploaded.length)} files, ${String(kilobytesOf(options.directory, uploaded))} KB`,
  )
  return EXIT_OK
}

/**
 * The `/a/{id}` page, not `result.viewUrl`. The artifact origin 404s without the grant cookie
 * `/enter` mints, so printing it hands the user an address that is dead for everyone including
 * them. `viewUrl` stays in the `--json` result, which is a pinned contract.
 */
function reportPushed(
  ctx: CliContext,
  options: PushCommandOptions,
  host: string,
  result: PushResult,
  isRepublish: boolean,
): void {
  writeSkippedBlock(ctx, result.skipped)
  printLine(
    ctx,
    `✓ ${String(result.uploaded.length)} files, ` +
      `${String(kilobytesOf(options.directory, result.uploaded))} KB`,
  )
  const short = shortId(result.artifactId)
  printLine(ctx, `✓ ${isRepublish ? 'updated' : 'created'} ${short}  v${String(result.versionNo)}`)
  printLine(ctx, `→ ${host}/a/${result.artifactId}`)
  const isPrivate = options.visibility === undefined || options.visibility === 'private'
  // Only true of a first push: a republish never changes the visibility it already has.
  if (options.visibility === undefined && !isRepublish) {
    printLine(ctx, '  private — only you can open that link')
  }
  printLine(ctx, `  share it:  enclave share create ${short} --expires 7d`)
  if (isPrivate && !isRepublish) {
    printLine(ctx, `  or open to the instance:  enclave privacy ${short} org`)
  }
}

/**
 * The 409 carries both numbers, which is what lets this say what happened without a second
 * request. Missing numbers still get a usable line rather than `undefined`. Human mode only:
 * `--json` keeps the server's code, message and details untouched.
 *
 * `inFlightVersionNo` is the other 409: nothing newer is published, but another push of this
 * artifact is still uploading. Its version numbers agree, so the first wording would read as a
 * contradiction. Older servers never send the field, so its absence falls through.
 */
function versionConflict(error: PushError): CliError {
  const { currentVersionNo, expectedVersionNo, inFlightVersionNo } = error.details
  if (typeof inFlightVersionNo === 'number') {
    return new CliError(
      error.code,
      `v${String(inFlightVersionNo)} is still uploading; retry shortly or use --force`,
    )
  }
  const serverAt = typeof currentVersionNo === 'number' ? `v${String(currentVersionNo)}` : 'ahead'
  const youAt = typeof expectedVersionNo === 'number' ? `v${String(expectedVersionNo)}` : 'behind'
  return new CliError(error.code, `server is at ${serverAt}, you last pushed ${youAt}`, {
    hints: ['refusing to overwrite a newer version', 're-run with --force to publish anyway'],
  })
}

/** Adds the next step a human needs to what push-core reported; `--json` sees none of it. */
function pushFailure(
  error: unknown,
  options: PushCommandOptions,
  host: string,
  isRepublish: boolean,
): PushError | CliError {
  const failure = asPushError(error)
  if (!(failure instanceof PushError) || options.isJson) return failure

  if (failure.code === 'VERSION_CONFLICT') return versionConflict(failure)
  const withHint = (hint: string): CliError =>
    new CliError(failure.code, failure.message, { details: failure.details, hints: [hint] })
  // The no-token path already names `enclave login`; a token the server rejected mid-push did not.
  if (failure.code === 'UNAUTHORIZED') return withHint(`log in again: enclave login --host ${host}`)
  // On the republish path a 404 means the artifact this directory tracked is gone server-side.
  if (failure.code === 'NOT_FOUND' && isRepublish) {
    return withHint('use --new to publish this directory as a new artifact')
  }
  return failure
}

/** stderr, never stdout: `--json` promises stdout carries the result object and nothing else. */
function announceUpload(ctx: CliContext, host: string, plan: UploadPlan): void {
  const kilobytes = Math.round(plan.totalBytes / BYTES_PER_KILOBYTE)
  printDiagnostic(
    ctx,
    `uploading ${String(plan.fileCount)} files (${String(kilobytes)} KB) to ${host}…`,
  )
}

/**
 * The file beside the directory is ambiguous: legacy state for *this* directory, or the live state
 * of a parent project that happens to contain it. Deleting it was once suggested outright, which
 * silently detached whichever artifact the parent was tracking.
 */
function legacyStateError(options: PushCommandOptions): CliError {
  const beside = legacyStatePath(options.directory)
  const inDir = statePath(options.directory)
  return new CliError(
    'LEGACY_STATE',
    `a .enclave.json sits beside ${options.directory}, at ${beside}, rather than inside it.\n` +
      `  if it is this directory's state, move it: mv ${beside} ${inDir}\n` +
      '  if it belongs to the parent directory, publish this one separately: push --new',
  )
}

/** Where the append is aimed, and what it will refuse to overwrite. `null` means create. */
interface RepublishTarget {
  readonly artifactId: string
  readonly expectedVersionNo?: number
}

/** `--artifact` names one artifact and `--new` insists on a different one, so the pair has no
 *  meaning. Malformed invocation, not a failed one. */
function refuseContradictoryFlags(options: PushCommandOptions): void {
  if (options.artifactRef === undefined || !options.isNew) return
  throw new CliError(
    'CONTRADICTORY_FLAGS',
    '--artifact names an artifact to append to; --new insists on a fresh one',
    { exitCode: EXIT_USAGE },
  )
}

/**
 * The resolved target. A full uuid costs no request, which is what keeps the everyday
 * `--artifact` push on `artifacts:write` alone; a prefix is matched against the caller's listing
 * and so also needs `artifacts:read`.
 */
async function resolveRepublishTarget(
  options: PushCommandOptions,
  state: ProjectState | null,
  host: string,
  token: string,
): Promise<RepublishTarget | null> {
  if (options.isNew) return null

  const guard =
    state === null || options.isForced ? {} : { expectedVersionNo: state.lastPushedVersionNo }

  if (options.artifactRef === undefined) {
    return state === null ? null : { artifactId: state.artifactId, ...guard }
  }

  let artifactId: string
  try {
    artifactId = await resolveArtifactId(
      apiClient(host, token, options.isInsecureAllowed ?? false),
      options.artifactRef,
    )
  } catch (error) {
    // One code for every way `--artifact` fails to name an artifact: it is the pinned contract.
    throw new CliError('INVALID_ARTIFACT', messageOf(error), {
      exitCode: error instanceof InvalidIdError ? EXIT_USAGE : EXIT_FAILED,
    })
  }

  if (state !== null && state.artifactId !== artifactId) {
    throw new CliError(
      'ARTIFACT_MISMATCH',
      `--artifact names ${shortId(artifactId)} but .enclave.json tracks ${shortId(state.artifactId)}`,
      { hints: ['delete the state file, or drop --artifact to keep pushing to it'] },
    )
  }

  // No state file means nothing to compare against, so the append is unconditional. This is the
  // fresh-checkout case `--artifact` exists for; the guard returns as soon as state is written.
  return { artifactId, ...guard }
}

function readStateOrRefuse(directory: string): ProjectState | null {
  try {
    return readState(directory)
  } catch (error) {
    throw new CliError('INVALID_STATE', messageOf(error))
  }
}

async function pushDirectory(options: PushCommandOptions, ctx: CliContext): Promise<ExitCode> {
  refuseContradictoryFlags(options)
  refuseUnusableDirectory(options)

  const state = readStateOrRefuse(options.directory)

  // --new and --artifact both already answer the question this guard asks: which artifact.
  const isTargetStated = options.isNew || options.artifactRef !== undefined
  if (state === null && !isTargetStated && existsSync(legacyStatePath(options.directory))) {
    throw legacyStateError(options)
  }

  const canonicalHost = resolveHost(state, options, ctx)
  refuseMismatchedHost(state, canonicalHost, options)
  const token = requireToken(canonicalHost, ctx)

  if (options.isDryRun) return reportDryRun(options, ctx)

  // After the dry run, which promises to make no request: resolving an `--artifact` prefix is one.
  // A state file names the artifact this directory already publishes to, so the push appends a
  // version to it. `--new` deliberately ignores it and creates a separate artifact.
  const republishTarget = await resolveRepublishTarget(options, state, canonicalHost, token)

  // The only read of the directory on this path: the dead-link check needs the files and `push`
  // takes the same bundle, so a 10 MB tree is not walked and read twice on the way to one request.
  const bundle = collectOrRefuse(options)
  const deadLinks = findDeadLinks(bundle.files)
  // Before the request, not after it: a warning that arrives once the version exists is a
  // post-mortem. Under --json the same findings ride in the result object instead.
  if (!options.isJson) writeDeadLinkBlock(ctx, deadLinks)

  let result: PushResult
  try {
    result = await push({
      directory: options.directory,
      bundle,
      host: canonicalHost,
      token,
      title: options.title ?? basename(resolve(options.directory)),
      visibility: options.visibility ?? 'private',
      isInsecureAllowed: options.isInsecureAllowed ?? false,
      userAgent: USER_AGENT,
      // Already carries the guard, or deliberately does not — see resolveRepublishTarget.
      ...(republishTarget ?? {}),
      ...(options.isJson
        ? {}
        : {
            onUploadStart: (plan: UploadPlan): void => {
              announceUpload(ctx, canonicalHost, plan)
            },
          }),
    })
  } catch (error) {
    throw pushFailure(error, options, canonicalHost, republishTarget !== null)
  }

  writeState(options.directory, {
    host: canonicalHost,
    artifactId: result.artifactId,
    lastPushedVersionNo: result.versionNo,
  })

  if (options.isJson) {
    printJson(ctx, { ...result, deadLinks })
    return EXIT_OK
  }

  reportPushed(ctx, options, canonicalHost, result, republishTarget !== null)
  return EXIT_OK
}

/** Errors, JSON or human, never land on stdout — `--json` promises stdout is nothing but the result. */
export async function runPush(options: PushCommandOptions, ctx: CliContext): Promise<ExitCode> {
  try {
    return await pushDirectory(options, ctx)
  } catch (error) {
    return reportFailure(error, ctx, { isJson: options.isJson })
  }
}
