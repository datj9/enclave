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

/** Errors, JSON or human, never land on stdout — `--json` promises stdout is nothing but the result. */
function reportError(isJson: boolean, code: string, message: string, humanText: string): void {
  if (isJson) {
    process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`)
    return
  }
  process.stderr.write(`${humanText}\n`)
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
  } catch (error) {
    const text = `.enclave.json has an invalid host '${state.host}': ${messageOf(error)}`
    reportError(options.isJson, 'INVALID_STATE', text, text)
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

type HostResolution =
  | { readonly canonicalHost: string; readonly failureExitCode: null }
  | { readonly failureExitCode: number }

function resolveHost(state: ProjectState | null, options: PushCommandOptions): HostResolution {
  const host = options.host ?? process.env['ENCLAVE_HOST'] ?? state?.host ?? ''
  if (host === '') {
    const text = 'no host: pass --host or set ENCLAVE_HOST'
    reportError(options.isJson, 'NO_HOST', text, text)
    return { failureExitCode: 2 }
  }

  try {
    const canonicalHost = normaliseHost(host, options.isInsecureAllowed ?? false)
    return { canonicalHost, failureExitCode: null }
  } catch (error) {
    const text = error instanceof InvalidHostError ? error.message : 'invalid host'
    reportError(options.isJson, 'INVALID_HOST', text, text)
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
    reportError(options.isJson, code, text, `✗ ${text}`)
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

function reportLegacyState(options: PushCommandOptions): number {
  const legacy = legacyStatePath(options.directory)
  const inDir = statePath(options.directory)
  const text =
    `found a legacy .enclave.json at ${legacy} — state now lives inside the pushed directory, not beside it.\n` +
    `  move it: mv ${legacy} ${inDir}\n` +
    `  or, if this should be a new artifact: rm ${legacy}`
  reportError(options.isJson, 'LEGACY_STATE', text, `✗ ${text}`)
  return 1
}

export async function runPush(options: PushCommandOptions): Promise<number> {
  let state: ProjectState | null
  try {
    state = readState(options.directory)
  } catch (error) {
    const text = error instanceof StateError ? error.message : messageOf(error)
    reportError(options.isJson, 'INVALID_STATE', text, `✗ ${text}`)
    return 1
  }

  if (state === null && existsSync(legacyStatePath(options.directory))) {
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
    })
  } catch (error) {
    const code = error instanceof PushError ? error.code : 'UNEXPECTED_RESPONSE'
    const text = messageOf(error)
    reportError(options.isJson, code, text, `✗ ${text}`)
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
