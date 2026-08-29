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
  DeadLink,
  PushResult,
  SkippedFile,
  SkipReason,
  UploadPlan,
} from '../../../push-core/src/index.ts'
import type { Visibility } from '../../../push-core/src/types.ts'
import { apiClient } from '../api-client.ts'
import { tokenFor } from '../credentials.ts'
import { InvalidIdError, resolveArtifactId, shortId } from '../ids.ts'
import { legacyStatePath, readState, StateError, statePath, writeState } from '../state.ts'
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
const SHORT_ID_LENGTH = 8

function reasonText(file: SkippedFile): string {
  switch (file.reason) {
    case 'unsupported_extension': {
      const fileName = file.path.slice(file.path.lastIndexOf('/') + 1)
      const dotIndex = fileName.lastIndexOf('.')
      return `unsupported (${dotIndex > 0 ? fileName.slice(dotIndex) : ''})`
    }
    case 'invalid_path':
      return 'invalid path'
    case 'ignored':
      return 'ignored'
    case 'too_large':
      return 'too large'
  }
}

function writeSkippedBlock(skipped: readonly SkippedFile[]): void {
  if (skipped.length === 0) return
  // `reduce`, not `Math.max(...paths)`: the list is unbounded and a spread can blow the argument
  // limit on a large tree.
  const pathColumnWidth = skipped.reduce((widest, file) => Math.max(widest, file.path.length), 0)
  process.stdout.write(`skipped ${String(skipped.length)} files:\n`)
  for (const file of skipped) {
    process.stdout.write(`  ${file.path.padEnd(pathColumnWidth)}  ${reasonText(file)}\n`)
  }
}

/**
 * Advice, not a refusal: the artifact origin 404s an unmatched path with a page that names
 * nothing, so a link the bundle cannot satisfy is worth saying out loud before it ships. stderr,
 * never stdout — stdout carries the result contract. Same `reduce` pattern as writeSkippedBlock.
 */
function writeDeadLinkBlock(deadLinks: readonly DeadLink[]): void {
  if (deadLinks.length === 0) return
  const fromColumnWidth = deadLinks.reduce((widest, link) => Math.max(widest, link.from.length), 0)
  process.stderr.write(
    `warning: ${String(deadLinks.length)} links point at files not in this bundle:\n`,
  )
  for (const link of deadLinks) {
    process.stderr.write(`  ${link.from.padEnd(fromColumnWidth)} → ${link.to}\n`)
  }
}

function kilobytesOf(directory: string, paths: readonly string[]): number {
  const totalBytes = paths.reduce(
    (runningTotal, path) => runningTotal + statSync(join(directory, path)).size,
    0,
  )
  return Math.round(totalBytes / BYTES_PER_KILOBYTE)
}

/** A Record, not a list: a new SkipReason breaks this literal instead of falling through
 *  to `[object Object]`. */
const SKIP_REASONS: Readonly<Record<SkipReason, true>> = {
  unsupported_extension: true,
  invalid_path: true,
  ignored: true,
  too_large: true,
}

function isSkippedFile(value: unknown): value is SkippedFile {
  if (typeof value !== 'object' || value === null) return false
  const { path, reason } = value as { path?: unknown; reason?: unknown }
  return (
    typeof path === 'string' && typeof reason === 'string' && Object.hasOwn(SKIP_REASONS, reason)
  )
}

/**
 * `String(value)` on the skipped array yields `[object Object]`, destroying the one fact that
 * explains the refusal. Null means the detail has nothing to say, so its line is dropped rather
 * than printed empty.
 */
function detailText(value: unknown): string | null {
  if (!Array.isArray(value)) return String(value)
  if (value.length === 0) return null
  return value
    .map((entry: unknown) =>
      isSkippedFile(entry) ? `${entry.path} (${reasonText(entry)})` : String(entry),
    )
    .join(', ')
}

/** Errors, JSON or human, never land on stdout — `--json` promises stdout is nothing but the result. */
function reportError(
  isJson: boolean,
  code: string,
  message: string,
  humanText: string,
  details: Readonly<Record<string, unknown>> = {},
): void {
  if (isJson) {
    const error =
      Object.keys(details).length === 0 ? { code, message } : { code, message, details }
    process.stderr.write(`${JSON.stringify({ error })}\n`)
    return
  }
  process.stderr.write(`${humanText}\n`)
  const rendered = Object.entries(details)
    .flatMap(([key, value]) => {
      const text = detailText(value)
      return text === null ? [] : [`${key}=${text}`]
    })
    .join(' ')
  if (rendered !== '') process.stderr.write(`  ${rendered}\n`)
}

/**
 * Checked before anything else reads the path: `collectBundle` throws a raw fs error from outside
 * every `--json` branch, and the catch that would label it belongs to the network push — which is
 * how a missing directory came to be reported as `UNEXPECTED_RESPONSE`.
 */
function refuseUnusableDirectory(options: PushCommandOptions): number | null {
  if (!existsSync(options.directory)) {
    const text = `no such directory: ${options.directory}`
    reportError(options.isJson, 'DIRECTORY_NOT_FOUND', text, `✗ ${text}`)
    return 2
  }
  if (!statSync(options.directory).isDirectory()) {
    const text = `${options.directory} is a file — push takes the directory that holds index.html`
    reportError(options.isJson, 'NOT_A_DIRECTORY', text, `✗ ${text}`)
    return 2
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Non-null is an exit code and means stop; null means the check passed. A state file no longer
 *  refuses the push — it directs it at the artifact it names — but it must still agree on host. */
function refuseMismatchedHost(
  state: ProjectState | null,
  host: string,
  options: PushCommandOptions,
): number | null {
  if (state === null || options.isNew) return null

  let stateHost: string
  try {
    stateHost = normaliseHost(state.host, options.isInsecureAllowed ?? false)
  } catch {
    // resolveHost already refused an unnormalisable host the push was relying on, so reaching here
    // means --host or ENCLAVE_HOST won and the state simply describes a different instance.
    const text = `state file targets '${state.host}', not ${host}`
    reportError(options.isJson, 'HOST_MISMATCH', text, text)
    return 1
  }

  if (stateHost !== host) {
    const text = `state file targets ${stateHost}, not ${host}`
    reportError(options.isJson, 'HOST_MISMATCH', text, text)
    return 1
  }

  return null
}

type HostSource = 'flag' | 'environment' | 'state'

/** The single place push's host precedence is written down — `refuseExistingState` reads the
 *  winning source from here rather than re-deriving it and drifting. */
function hostCandidate(
  state: ProjectState | null,
  options: PushCommandOptions,
): { readonly value: string; readonly source: HostSource } | null {
  if (options.host !== undefined && options.host !== '') {
    return { value: options.host, source: 'flag' }
  }
  const fromEnvironment = process.env['ENCLAVE_HOST']
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return { value: fromEnvironment, source: 'environment' }
  }
  if (state !== null && state.host !== '') return { value: state.host, source: 'state' }
  return null
}

type HostResolution =
  | { readonly canonicalHost: string; readonly failureExitCode: null }
  | { readonly failureExitCode: number }

function resolveHost(state: ProjectState | null, options: PushCommandOptions): HostResolution {
  const candidate = hostCandidate(state, options)
  if (candidate === null) {
    const text = 'no host: pass --host or set ENCLAVE_HOST'
    reportError(options.isJson, 'NO_HOST', text, text)
    return { failureExitCode: 2 }
  }

  try {
    const canonicalHost = normaliseHost(candidate.value, options.isInsecureAllowed ?? false)
    return { canonicalHost, failureExitCode: null }
  } catch (error) {
    const reason = error instanceof InvalidHostError ? error.message : 'invalid host'
    // A host that came from the state file appears nowhere on the command line, so naming the file
    // is the whole diagnosis — and an unusable file is a failure, not a malformed invocation.
    if (candidate.source === 'state') {
      const text = `${statePath(options.directory)} has an invalid host '${candidate.value}': ${reason}`
      reportError(options.isJson, 'INVALID_STATE', text, `✗ ${text}`)
      return { failureExitCode: 1 }
    }
    reportError(options.isJson, 'INVALID_HOST', reason, reason)
    return { failureExitCode: 2 }
  }
}

function reportDryRun(options: PushCommandOptions): number {
  const bundle = collectBundle(options.directory)

  try {
    assertBundlePushable(bundle.files, bundle.skipped)
  } catch (error) {
    const code = error instanceof PushError ? error.code : 'UNEXPECTED_RESPONSE'
    const text = messageOf(error)
    const details = error instanceof PushError ? error.details : {}
    reportError(options.isJson, code, text, `✗ ${text}`, details)
    return 1
  }

  const uploaded = bundle.files.map((file) => file.path)
  const deadLinks = findDeadLinks(bundle.files)

  if (options.isJson) {
    process.stdout.write(
      `${JSON.stringify({ uploaded, skipped: bundle.skipped, deadLinks })}\n`,
    )
    return 0
  }

  writeDeadLinkBlock(deadLinks)
  writeSkippedBlock(bundle.skipped)
  process.stdout.write(
    `✓ ${String(uploaded.length)} files, ${String(kilobytesOf(options.directory, uploaded))} KB\n`,
  )
  return 0
}

/**
 * The `/a/{id}` page, not `result.viewUrl`. The artifact origin 404s without the grant cookie
 * `/enter` mints, so printing it hands the user an address that is dead for everyone including
 * them. `viewUrl` stays in the `--json` result, which is a pinned contract.
 */
function reportPushed(
  options: PushCommandOptions,
  host: string,
  result: PushResult,
  isRepublish: boolean,
): void {
  writeSkippedBlock(result.skipped)
  process.stdout.write(
    `✓ ${String(result.uploaded.length)} files, ` +
      `${String(kilobytesOf(options.directory, result.uploaded))} KB\n`,
  )
  const shortId = result.artifactId.slice(0, SHORT_ID_LENGTH)
  process.stdout.write(
    `✓ ${isRepublish ? 'updated' : 'created'} ${shortId}  v${String(result.versionNo)}\n`,
  )
  process.stdout.write(`→ ${host}/a/${result.artifactId}\n`)
  const isPrivate = options.visibility === undefined || options.visibility === 'private'
  // Only true of a first push: a republish never changes the visibility it already has.
  if (options.visibility === undefined && !isRepublish) {
    process.stdout.write('  private — only you can open that link\n')
  }
  process.stdout.write(`  share it:  enclave share create ${shortId} --expires 7d\n`)
  if (isPrivate && !isRepublish) {
    process.stdout.write(`  or open to the instance:  enclave privacy ${shortId} org\n`)
  }
}

/** The 409 carries both numbers, which is what lets this say what happened without a second
 *  request. Missing numbers still get a usable line rather than `undefined`. */
function reportVersionConflict(error: PushError): void {
  const { currentVersionNo, expectedVersionNo } = error.details
  const serverAt = typeof currentVersionNo === 'number' ? `v${String(currentVersionNo)}` : 'ahead'
  const youAt = typeof expectedVersionNo === 'number' ? `v${String(expectedVersionNo)}` : 'behind'
  process.stderr.write(`✗ server is at ${serverAt}, you last pushed ${youAt}\n`)
  process.stderr.write('  refusing to overwrite a newer version\n')
  process.stderr.write('  re-run with --force to publish anyway\n')
}

/** stderr, never stdout: `--json` promises stdout carries the result object and nothing else. */
function announceUpload(host: string, plan: UploadPlan): void {
  const kilobytes = Math.round(plan.totalBytes / BYTES_PER_KILOBYTE)
  process.stderr.write(
    `uploading ${String(plan.fileCount)} files (${String(kilobytes)} KB) to ${host}…\n`,
  )
}

/**
 * The file beside the directory is ambiguous: legacy state for *this* directory, or the live state
 * of a parent project that happens to contain it. Deleting it was once suggested outright, which
 * silently detached whichever artifact the parent was tracking.
 */
function reportLegacyState(options: PushCommandOptions): number {
  const beside = legacyStatePath(options.directory)
  const inDir = statePath(options.directory)
  const text =
    `a .enclave.json sits beside ${options.directory}, at ${beside}, rather than inside it.\n` +
    `  if it is this directory's state, move it: mv ${beside} ${inDir}\n` +
    "  if it belongs to the parent directory, publish this one separately: push --new"
  reportError(options.isJson, 'LEGACY_STATE', text, `✗ ${text}`)
  return 1
}

/** Where the append is aimed, and what it will refuse to overwrite. `null` means create. */
interface RepublishTarget {
  readonly artifactId: string
  readonly expectedVersionNo?: number
}

/** `--artifact` names one artifact and `--new` insists on a different one, so the pair has no
 *  meaning. Malformed invocation, not a failed one. */
function refuseContradictoryFlags(options: PushCommandOptions): number | null {
  if (options.artifactRef === undefined || !options.isNew) return null
  const text = '--artifact names an artifact to append to; --new insists on a fresh one'
  reportError(options.isJson, 'CONTRADICTORY_FLAGS', text, `✗ ${text}`)
  return 2
}

/**
 * The resolved id, or an exit code. A full uuid costs no request, which is what keeps the everyday
 * `--artifact` push on `artifacts:write` alone; a prefix is matched against the caller's listing
 * and so also needs `artifacts:read`.
 */
async function resolveRepublishTarget(
  options: PushCommandOptions,
  state: ProjectState | null,
  host: string,
  token: string,
): Promise<RepublishTarget | number | null> {
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
    const text = messageOf(error)
    reportError(options.isJson, 'INVALID_ARTIFACT', text, `✗ ${text}`)
    return error instanceof InvalidIdError ? 2 : 1
  }

  if (state !== null && state.artifactId !== artifactId) {
    const text =
      `--artifact names ${shortId(artifactId)} but .enclave.json tracks ` +
      `${shortId(state.artifactId)}`
    reportError(
      options.isJson,
      'ARTIFACT_MISMATCH',
      text,
      `✗ ${text}\n  delete the state file, or drop --artifact to keep pushing to it`,
    )
    return 1
  }

  // No state file means nothing to compare against, so the append is unconditional. This is the
  // fresh-checkout case `--artifact` exists for; the guard returns as soon as state is written.
  return { artifactId, ...guard }
}

export async function runPush(options: PushCommandOptions): Promise<number> {
  const contradiction = refuseContradictoryFlags(options)
  if (contradiction !== null) return contradiction

  const unusableDirectory = refuseUnusableDirectory(options)
  if (unusableDirectory !== null) return unusableDirectory

  let state: ProjectState | null
  try {
    state = readState(options.directory)
  } catch (error) {
    const text = error instanceof StateError ? error.message : messageOf(error)
    reportError(options.isJson, 'INVALID_STATE', text, `✗ ${text}`)
    return 1
  }

  // --new and --artifact both already answer the question this guard asks: which artifact.
  const isTargetStated = options.isNew || options.artifactRef !== undefined
  if (state === null && !isTargetStated && existsSync(legacyStatePath(options.directory))) {
    return reportLegacyState(options)
  }

  const hostResolution = resolveHost(state, options)
  if (hostResolution.failureExitCode !== null) return hostResolution.failureExitCode
  const { canonicalHost } = hostResolution

  const mismatch = refuseMismatchedHost(state, canonicalHost, options)
  if (mismatch !== null) return mismatch

  const token = tokenFor(canonicalHost)
  if (token === null) {
    const text = `run: enclave login --host ${canonicalHost}`
    reportError(options.isJson, 'NOT_AUTHENTICATED', text, text)
    return 1
  }

  if (options.isDryRun) return reportDryRun(options)

  // After the dry run, which promises to make no request: resolving an `--artifact` prefix is one.
  // A state file names the artifact this directory already publishes to, so the push appends a
  // version to it. `--new` deliberately ignores it and creates a separate artifact.
  const target = await resolveRepublishTarget(options, state, canonicalHost, token)
  if (typeof target === 'number') return target
  const republishTarget = target

  const isProgressVisible = !options.isJson

  // `push()` collects internally and holds no files, so the dead-link check that needs them reads
  // the directory once more — a few files off local disk, and it stays out of the network path.
  const bundle = collectBundle(options.directory)
  const deadLinks = findDeadLinks(bundle.files)

  let result: PushResult
  try {
    result = await push({
      directory: options.directory,
      host: canonicalHost,
      token,
      title: options.title ?? basename(resolve(options.directory)),
      visibility: options.visibility ?? 'private',
      isInsecureAllowed: options.isInsecureAllowed ?? false,
      userAgent: USER_AGENT,
      // Already carries the guard, or deliberately does not — see resolveRepublishTarget.
      ...(republishTarget ?? {}),
      ...(isProgressVisible
        ? {
            onUploadStart: (plan: UploadPlan): void => {
              announceUpload(canonicalHost, plan)
            },
          }
        : {}),
    })
  } catch (error) {
    const code = error instanceof PushError ? error.code : 'UNEXPECTED_RESPONSE'
    const text = messageOf(error)
    const details = error instanceof PushError ? error.details : {}

    if (code === 'VERSION_CONFLICT' && !options.isJson && error instanceof PushError) {
      reportVersionConflict(error)
      return 1
    }

    reportError(options.isJson, code, text, `✗ ${text}`, details)
    // The no-token path already prints this; a token the server rejected mid-push did not.
    if (code === 'UNAUTHORIZED' && !options.isJson) {
      process.stderr.write(`  log in again: enclave login --host ${canonicalHost}\n`)
    }
    // On the republish path a 404 means the artifact this directory tracked is gone server-side.
    if (code === 'NOT_FOUND' && republishTarget !== null && !options.isJson) {
      process.stderr.write('  use --new to publish this directory as a new artifact\n')
    }
    return 1
  }

  writeState(options.directory, {
    host: canonicalHost,
    artifactId: result.artifactId,
    lastPushedVersionNo: result.versionNo,
  })

  if (options.isJson) {
    process.stdout.write(`${JSON.stringify({ ...result, deadLinks })}\n`)
    return 0
  }

  writeDeadLinkBlock(deadLinks)
  reportPushed(options, canonicalHost, result, republishTarget !== null)
  return 0
}
