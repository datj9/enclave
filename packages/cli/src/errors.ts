import { PushError } from '../../push-core/src/index.ts'

import { ApiError } from './api-client.ts'
import { CredentialError } from './credentials.ts'
import { EXIT_FAILED, EXIT_USAGE, type ExitCode } from './exit-codes.ts'
import { IdResolutionError, InvalidIdError } from './ids.ts'
import { messageOf, printDiagnostic, renderDetails, type CliContext } from './output.ts'
import { StateError } from './state.ts'

export interface CliErrorOptions {
  readonly exitCode?: ExitCode
  /** Follow-up lines for a human: what to run next. Never part of the `--json` envelope. */
  readonly hints?: readonly string[]
  readonly details?: Readonly<Record<string, unknown>>
  /** Replaces the `✗ message` line in human mode when the message alone reads badly there. */
  readonly humanMessage?: string
}

/**
 * A failure the CLI has already put into words. `code` is the stable, machine-readable half that a
 * `--json` caller branches on; `message` may be reworded between releases.
 */
export class CliError extends Error {
  readonly code: string
  readonly exitCode: ExitCode
  readonly hints: readonly string[]
  readonly details: Readonly<Record<string, unknown>>
  readonly humanMessage: string | undefined

  constructor(code: string, message: string, options: CliErrorOptions = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = options.exitCode ?? EXIT_FAILED
    this.hints = options.hints ?? []
    this.details = options.details ?? {}
    this.humanMessage = options.humanMessage
  }
}

/** A value refused before any request was made — exit 2, like every other unusable argument. */
export function invalidArgument(message: string, hints: readonly string[] = []): CliError {
  return new CliError('INVALID_ARGUMENT', message, { exitCode: EXIT_USAGE, hints })
}

export interface FailureContext {
  readonly isJson: boolean
  /** The canonical host, when one was resolved — it lets a 401/403 name the exact recovery command. */
  readonly host?: string
  /** The id the user typed, echoed back on "not found" so a typo is visible. */
  readonly given?: string
  /** The scope the command needs, named on a 401 so the user mints the right token. */
  readonly requiredScope?: string
  /**
   * The share routes answer a readable-but-not-owned artifact with 403. Echoing that confirms the
   * artifact exists to someone who does not own it, so those commands report it as "not found" —
   * the same words a 404 gets.
   */
  readonly isForbiddenNotFound?: boolean
}

/** `main` hands over a normalised `https://host`; a caller that resolved its own passes a bare
 *  name. Both spellings have to reach a URL. */
export function originOf(host: string): string {
  return host.includes('://') ? host : `https://${host}`
}

function isScopeRefusal(error: ApiError): boolean {
  return error.status === 403 && error.message.toLowerCase().includes('scope')
}

/** `requireApiPrincipal` answers a bearer token sent over plain http in production with 403. */
function isTransportRefusal(error: ApiError): boolean {
  return error.status === 403 && error.message.toLowerCase().includes('https')
}

function notFound(failure: FailureContext): CliError {
  return new CliError(
    'NOT_FOUND',
    failure.given === undefined ? 'not found' : `not found: ${failure.given}`,
  )
}

function loginHint(host: string | undefined): readonly string[] {
  return host === undefined ? [] : [`log in again: enclave login --host ${host}`]
}

function fromApiError(error: ApiError, failure: FailureContext): CliError {
  // A 404 is what the server returns for another user's artifact, deliberately. Printing
  // "forbidden" would confirm it exists, so every 404 reads the same as a typo.
  if (error.status === 404) return notFound(failure)

  if (error.status === 401) {
    return new CliError(
      error.code,
      'the API token was rejected — it may be expired, revoked, or minted for another host',
      {
        hints: [
          ...(failure.requiredScope === undefined
            ? []
            : [`this command needs a token with scope ${failure.requiredScope}`]),
          ...loginHint(failure.host),
        ],
      },
    )
  }

  // Kept off the 401 branch on purpose: a token that authenticated but lacks a scope is refused
  // with 403, and logging in again with that same token changes nothing.
  if (isScopeRefusal(error)) {
    const scope =
      failure.requiredScope === undefined ? 'that scope' : `scope ${failure.requiredScope}`
    return new CliError(error.code, error.message, {
      hints:
        failure.host === undefined
          ? [`mint a token with ${scope}`]
          : [
              `mint a token with ${scope} at ${originOf(failure.host)}/settings/tokens,`,
              `then: enclave login --host ${failure.host}`,
            ],
    })
  }

  // Only the ownership 403 is folded into "not found". The plaintext-transport 403 is refused
  // before any artifact is looked up, so it confirms nothing, and hiding it would send the user
  // chasing a typo in an id that is fine.
  if (error.status === 403 && failure.isForbiddenNotFound === true && !isTransportRefusal(error)) {
    return notFound(failure)
  }

  return new CliError(error.code, error.message, { details: error.details })
}

/** Every error a command can raise, put into the one shape the reporter prints. */
function toCliError(error: unknown, failure: FailureContext): CliError {
  if (error instanceof CliError) return error
  if (error instanceof ApiError) return fromApiError(error, failure)
  // Before its parent: a prefix too short to resolve is a malformed argument, not a lookup that
  // came back empty — callers distinguish those by exit code.
  if (error instanceof InvalidIdError) {
    return new CliError('INVALID_ID', error.message, { exitCode: EXIT_USAGE })
  }
  if (error instanceof IdResolutionError) {
    return new CliError('ARTIFACT_NOT_RESOLVED', error.message)
  }
  if (error instanceof CredentialError) return new CliError('INVALID_CREDENTIALS', error.message)
  if (error instanceof StateError) return new CliError('INVALID_STATE', error.message)
  if (error instanceof PushError) {
    return new CliError(error.code, error.message, {
      details: error.details,
      // The no-token path already names `enclave login`; a token rejected mid-request did not.
      hints: error.code === 'UNAUTHORIZED' ? loginHint(failure.host) : [],
    })
  }
  return new CliError('UNEXPECTED_ERROR', messageOf(error))
}

/**
 * The one place a failure becomes output and an exit code. Under `--json` the failure is exactly
 * one line, `{"error":{"code","message"[,"details"]}}`, and it is the last line on stderr —
 * warnings written earlier in the run (the `--expires` disclosure, an ENCLAVE_TOKEN override)
 * may precede it. Otherwise a `✗` line, any details, then the hints. stdout is never written.
 */
export function reportFailure(error: unknown, ctx: CliContext, failure: FailureContext): ExitCode {
  const reported = toCliError(error, failure)

  if (failure.isJson) {
    const hasDetails = Object.keys(reported.details).length > 0
    const envelope = {
      code: reported.code,
      message: reported.message,
      ...(hasDetails ? { details: reported.details } : {}),
    }
    printDiagnostic(ctx, JSON.stringify({ error: envelope }))
    return reported.exitCode
  }

  printDiagnostic(ctx, `✗ ${reported.humanMessage ?? reported.message}`)
  const details = renderDetails(reported.details)
  if (details !== null) printDiagnostic(ctx, `  ${details}`)
  for (const hint of reported.hints) printDiagnostic(ctx, `  ${hint}`)
  return reported.exitCode
}
