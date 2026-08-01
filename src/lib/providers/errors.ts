import { HttpError } from '@/lib/http'

/**
 * Provider failures, mapped to the §5.3 codes. Messages are fixed strings: a provider's own error
 * body can echo request material, and §8 forbids anything from a key to a prompt reaching a log
 * line or a client. The one exception is a refusal, whose message the user is meant to see.
 */

const UNAUTHORIZED_STATUSES = new Set([401, 403])
const RATE_LIMITED_STATUS = 429
const PROVIDER_FAILED_STATUS = 502

const KEY_INVALID_MESSAGE = 'The provider rejected the configured API key'
const RATE_LIMITED_MESSAGE = 'The model provider is rate-limiting this instance'
const UNAVAILABLE_MESSAGE = 'The model provider could not be reached'

export const REFUSAL_MESSAGE = 'The model declined to build this artifact'

interface ApiErrorLike {
  readonly status?: unknown
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as ApiErrorLike).status
  return typeof status === 'number' ? status : undefined
}

export function providerRefusal(modelMessage: string): HttpError {
  const trimmed = modelMessage.trim()
  return new HttpError('PROVIDER_REFUSED', trimmed === '' ? REFUSAL_MESSAGE : trimmed)
}

/**
 * `HttpError` passes straight through so a refusal raised mid-stream keeps its own code. A 429 is
 * reported and never retried — decision from §7, and the SDKs are constructed with `maxRetries: 0`
 * so the transport cannot retry behind our back either.
 */
export function toProviderError(error: unknown): HttpError {
  if (error instanceof HttpError) return error

  const status = statusOf(error)
  if (status !== undefined && UNAUTHORIZED_STATUSES.has(status)) {
    return new HttpError('PROVIDER_KEY_INVALID', KEY_INVALID_MESSAGE)
  }
  if (status === RATE_LIMITED_STATUS) {
    return new HttpError('PROVIDER_RATE_LIMITED', RATE_LIMITED_MESSAGE)
  }
  return new HttpError('INTERNAL_ERROR', UNAVAILABLE_MESSAGE, { status: PROVIDER_FAILED_STATUS })
}
