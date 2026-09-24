import { requireSameOriginRequest } from '@/lib/api/guards'
import { clearSessionCookie } from '@/lib/auth/session'
import { seeOther, toErrorResponse } from '@/lib/http'

export const dynamic = 'force-dynamic'

/**
 * The dashboard's sign-out is a plain HTML form, which a same-site artifact page could also
 * submit. Forced sign-out is low impact, but the origin check keeps every cookie-authenticated
 * POST under the same rule.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginRequest(request)
  } catch (error) {
    return toErrorResponse(error)
  }
  return seeOther('/signin', { 'set-cookie': clearSessionCookie() })
}
