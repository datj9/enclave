import { baseUrlFor } from '../../push-core/src/index.ts'
import { USER_AGENT } from './version.ts'

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

/** The server's envelope is `{data:…}` on success; anything else is a transport fault. */
function unwrapData<T>(body: unknown, path: string, status: number): T {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new ApiError(status, 'UNEXPECTED_RESPONSE', `Response from ${path} is missing a data envelope`, {
      path,
    })
  }
  return (body as { data: T }).data
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
/**
 * Node's `fetch` waits forever. A host that accepts the connection and then says nothing — a
 * captive portal, a hung proxy — otherwise leaves the CLI printing nothing, with no way to tell
 * "slow" from "dead". These calls carry metadata only, so the ceiling can be short.
 */
const REQUEST_TIMEOUT_MS = 30_000

export function apiClient(host: string, token: string, isInsecureAllowed = false): ApiClient {
  const baseUrl = baseUrlFor(host, isInsecureAllowed)

  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
    }
    if (body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new ApiError(0, 'NETWORK_TIMEOUT', `${host} did not answer within 30s`, { host })
      }
      throw new ApiError(0, 'NETWORK_ERROR', `Could not reach ${host}`, { host })
    }

    if (!response.ok) throw await errorFrom(response)
    return response
  }

  return {
    async get<T>(path: string): Promise<T> {
      const response = await send('GET', path)
      return unwrapData<T>(await response.json(), path, response.status)
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      const response = await send('POST', path, body)
      return unwrapData<T>(await response.json(), path, response.status)
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      const response = await send('PATCH', path, body)
      return unwrapData<T>(await response.json(), path, response.status)
    },
    async remove(path: string): Promise<void> {
      await send('DELETE', path)
    },
  }
}
