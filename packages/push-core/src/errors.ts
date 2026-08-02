export type PushErrorCode =
  | 'NOTHING_TO_UPLOAD'
  | 'ENTRY_MISSING'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'BUNDLE_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'INSECURE_HOST'
  | 'NETWORK_ERROR'
  | 'UNEXPECTED_RESPONSE'

export class PushError extends Error {
  readonly code: PushErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: PushErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PushError'
    this.code = code
    this.details = details
  }
}
