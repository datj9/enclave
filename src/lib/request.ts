/**
 * Body reading shared by the auth routes. They serve two callers: a browser HTML form
 * (urlencoded body, wants a 303) and an API client (JSON body, wants the §5.3 envelope).
 */

export type RequestBody = Readonly<Record<string, unknown>>

export async function readRequestBody(request: Request): Promise<RequestBody> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    try {
      const parsed: unknown = await request.json()
      const isRecord = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      return isRecord ? (parsed as RequestBody) : {}
    } catch {
      return {}
    }
  }

  const formData = await request.formData()
  return Object.fromEntries(
    Array.from(formData.entries()).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : undefined,
    ]),
  )
}

/** A form POST gets a redirect; anything asking for JSON gets the error envelope. */
export function wantsJsonResponse(request: Request): boolean {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return true
  const accept = request.headers.get('accept') ?? ''
  return accept.includes('application/json') && !accept.includes('text/html')
}
