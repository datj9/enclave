import { isOidcEnabled, startAuthorization } from '@/lib/auth/oidc'
import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { HttpError, jsonError, seeOther, toErrorResponse } from '@/lib/http'

export const dynamic = 'force-dynamic'

/**
 * Begins the authorization-code flow. 302 rather than 303 because there is no form submission
 * to convert — the browser is already doing a GET (S11 contract).
 */
export async function GET(request: Request): Promise<Response> {
  if (!isOidcEnabled()) return jsonError('NOT_FOUND', 'Not found')

  try {
    enforceAuthRateLimit(request, 'oidc-start')

    const { location, setCookie } = await startAuthorization()
    return new Response(null, { status: 302, headers: { location, 'set-cookie': setCookie } })
  } catch (error) {
    if (error instanceof HttpError) return toErrorResponse(error)
    // Discovery failed or the provider is unreachable: keep the operator's URL out of the
    // response and put the visitor back on the form that still works.
    return seeOther('/signin?error=oidc')
  }
}
