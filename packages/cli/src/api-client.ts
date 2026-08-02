import { baseUrlFor } from '../../push-core/src/index.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body: unknown): Promise<T>
  patch<T>(path: string, body: unknown): Promise<T>
  remove(path: string): Promise<void>
}

/** The server's envelope is `{error:{code,message,details}}`; anything else is a transport fault. */
async function errorFrom(response: Response): Promise<ApiError> {
  let code = 'UNEXPECTED_RESPONSE'
  let message = `The server returned ${String(response.status)}`
  let details: Record<string, unknown> = {}

  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const envelope = (body as { error: { code?: string; message?: string; details?: unknown } })
        .error
      if (typeof envelope.code === 'string') code = envelope.code
      if (typeof envelope.message === 'string') message = envelope.message
      if (typeof envelope.details === 'object' && envelope.details !== null) {
        details = envelope.details as Record<string, unknown>
      }
    }
  } catch {
    // A non-JSON body carries nothing the status has not already said.
  }

  return new ApiError(response.status, code, message, details)
}

/**
 * The token is held in this closure and reaches exactly one place: the Authorization header.
 * It is never attached to an ApiError, so no caller can print it by echoing a failure.
 */
export function apiClient(host: string, token: string): ApiClient {
  const baseUrl = baseUrlFor(host)

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', `Could not reach ${host}`, { host })
    }

    if (!response.ok) throw await errorFrom(response)
    return response
  }

  return {
    async get<T>(path: string): Promise<T> {
      return (await (await send('GET', path)).json()) as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return (await (await send('POST', path, body)).json()) as T
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      return (await (await send('PATCH', path, body)).json()) as T
    },
    async remove(path: string): Promise<void> {
      await send('DELETE', path)
    },
  }
}
