import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  assertBundlePushable,
  collectBundle,
  InvalidHostError,
  normaliseHost,
  push,
  PushError,
} from '../../../push-core/src/index.ts'
import type { PushResult, SkippedFile } from '../../../push-core/src/index.ts'
import type { Visibility } from '../../../push-core/src/types.ts'
import { tokenFor } from '../credentials.ts'
import { legacyStatePath, readState, StateError, statePath, writeState } from '../state.ts'
import type { ProjectState } from '../state.ts'
import { USER_AGENT } from '../version.ts'

export interface PushCommandOptions {
  readonly directory: string
  readonly host?: string
  readonly title?: string
  readonly visibility?: Visibility
  readonly isNew: boolean
  readonly isDryRun: boolean
  readonly isJson: boolean
  readonly isInsecureAllowed?: boolean
}

const SKIP_COLUMN_WIDTH = 18
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
  process.stdout.write(`skipped ${String(skipped.length)} files:\n`)
  for (const file of skipped) {
    process.stdout.write(`  ${file.path.padEnd(SKIP_COLUMN_WIDTH)}${reasonText(file)}\n`)
  }
}

function kilobytesOf(directory: string, paths: readonly string[]): number {
  const totalBytes = paths.reduce(
    (runningTotal, path) => runningTotal + statSync(join(directory, path)).size,
    0,
  )
  return Math.round(totalBytes / BYTES_PER_KILOBYTE)
}

const SKIP_REASONS: readonly unknown[] = [
  'unsupported_extension',
  'invalid_path',
  'ignored',
  'too_large',
]

function isSkippedFile(value: unknown): value is SkippedFile {
  if (typeof value !== 'object' || value === null) return false
  const { path, reason } = value as { path?: unknown; reason?: unknown }
  return typeof path === 'string' && SKIP_REASONS.includes(reason)
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

/** Non-null is an exit code and means stop; null means the check passed. */
function refuseExistingState(
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

  const shortId = state.artifactId.slice(0, SHORT_ID_LENGTH)
  reportError(
    options.isJson,
    'STATE_EXISTS',
    `.enclave.json exists (artifact ${shortId}); republishing lands in S15`,
    `✗ .enclave.json exists (artifact ${shortId})\n` +
      '  republishing lands in S15\n' +
      '  use --new to create a separate artifact',
  )
  return 1
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

  if (options.isJson) {
    process.stdout.write(`${JSON.stringify({ uploaded, skipped: bundle.skipped })}\n`)
    return 0
  }

  writeSkippedBlock(bundle.skipped)
  process.stdout.write(
    `✓ ${String(uploaded.length)} files, ${String(kilobytesOf(options.directory, uploaded))} KB\n`,
  )
  return 0
}

function reportPushed(options: PushCommandOptions, result: PushResult): void {
  writeSkippedBlock(result.skipped)
  process.stdout.write(
    `✓ ${String(result.uploaded.length)} files, ` +
      `${String(kilobytesOf(options.directory, result.uploaded))} KB\n`,
  )
  process.stdout.write(
    `✓ created ${result.artifactId.slice(0, SHORT_ID_LENGTH)}  v${String(result.versionNo)}\n`,
  )
  process.stdout.write(`→ ${result.viewUrl}\n`)
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

export async function runPush(options: PushCommandOptions): Promise<number> {
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

  // --new already says this directory is its own artifact, which is the answer the guard asks for.
  if (state === null && !options.isNew && existsSync(legacyStatePath(options.directory))) {
    return reportLegacyState(options)
  }

  const hostResolution = resolveHost(state, options)
  if (hostResolution.failureExitCode !== null) return hostResolution.failureExitCode
  const { canonicalHost } = hostResolution

  const refusal = refuseExistingState(state, canonicalHost, options)
  if (refusal !== null) return refusal

  const token = tokenFor(canonicalHost)
  if (token === null) {
    const text = `run: enclave login --host ${canonicalHost}`
    reportError(options.isJson, 'NOT_AUTHENTICATED', text, text)
    return 1
  }

  if (options.isDryRun) return reportDryRun(options)

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
    })
  } catch (error) {
    const code = error instanceof PushError ? error.code : 'UNEXPECTED_RESPONSE'
    const text = messageOf(error)
    const details = error instanceof PushError ? error.details : {}
    reportError(options.isJson, code, text, `✗ ${text}`, details)
    return 1
  }

  writeState(options.directory, {
    host: canonicalHost,
    artifactId: result.artifactId,
    lastPushedVersionNo: 1,
  })

  if (options.isJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  }

  reportPushed(options, result)
  return 0
}
