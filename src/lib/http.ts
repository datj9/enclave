/**
 * The one response envelope, per grill-result §5.3. Every API route in every slice returns
 * `jsonData` or `jsonError` — nothing hand-rolls `NextResponse.json`.
 */

/** The complete §5.3 union. Most codes are unused until a later slice throws them. */
export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'BUNDLE_TOO_LARGE'
  | 'FILE_TYPE_NOT_ALLOWED'
  | 'PATH_INVALID'
  | 'ENTRY_MISSING'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_KEY_INVALID'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_REFUSED'
  | 'MALFORMED_MODEL_OUTPUT'
  | 'STORAGE_UNAVAILABLE'
  | 'VERSION_CONFLICT'
  | 'INTERNAL_ERROR'

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  BUNDLE_TOO_LARGE: 413,
  FILE_TYPE_NOT_ALLOWED: 422,
  PATH_INVALID: 422,
  ENTRY_MISSING: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  PROVIDER_KEY_INVALID: 400,
  PROVIDER_RATE_LIMITED: 502,
  PROVIDER_REFUSED: 422,
  MALFORMED_MODEL_OUTPUT: 502,
  STORAGE_UNAVAILABLE: 503,
  VERSION_CONFLICT: 409,
  INTERNAL_ERROR: 500,
}

export type ErrorDetails = Record<string, unknown>

export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly details?: ErrorDetails
  }
}

export interface DataBody<TData> {
  readonly data: TData
}

interface ErrorOptions {
  readonly details?: ErrorDetails
  /** Overrides the §5.3 default status. `VALIDATION_FAILED` is 422 there but 409 on /setup. */
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const

export function jsonData<TData>(
  data: TData,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body: DataBody<TData> = { data }
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
}

export function jsonError(code: ErrorCode, message: string, options: ErrorOptions = {}): Response {
  const body: ErrorBody = {
    error:
      options.details === undefined
        ? { code, message }
        : { code, message, details: options.details },
  }
  return new Response(JSON.stringify(body), {
    status: options.status ?? ERROR_STATUS[code],
    headers: { ...JSON_HEADERS, ...options.headers },
  })
}

/**
 * Thrown from anywhere below a route handler; `toErrorResponse` renders it. Keeps deep
 * helpers free of Response-building while preserving the exact code and status.
 */
export class HttpError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: ErrorDetails | undefined
  readonly headers: Readonly<Record<string, string>>

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.status = options.status ?? ERROR_STATUS[code]
    this.details = options.details
    this.headers = options.headers ?? {}
  }
}

/**
 * Last line of defence in a route handler's catch block. Unknown throwables collapse to a
 * generic 500 so no stack trace, bucket name, or file path reaches a client (§8 error hygiene).
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.code, error.message, {
      status: error.status,
      headers: error.headers,
      ...(error.details === undefined ? {} : { details: error.details }),
    })
  }
  return jsonError('INTERNAL_ERROR', 'Something went wrong')
}

/** 303 so a browser form POST becomes a GET of the destination. */
export function seeOther(
  location: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } })
}
