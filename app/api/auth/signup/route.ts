import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { createSessionCookie } from '@/lib/auth/session'
import { HttpError, seeOther, toErrorResponse } from '@/lib/http'
import { registerMember, signupSchema } from '@/lib/invites/register'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'
import { INVITE_TOKEN_PARAMETER, SIGNUP_PATH } from '@/lib/invites/tokens'

/**
 * `POST /api/auth/signup` — redeem an invite and become a member. Serves both callers the way
 * `/api/setup` does: a browser form gets a 303 back to the form on failure, an API client gets the
 * §5.3 envelope with the real status (410 for a used or expired invite).
 *
 * Never log the token (§8 log hygiene). Carrying it in the redirect is not a new exposure — it
 * arrived in the invite URL and is already in that page's address bar.
 */

export const dynamic = 'force-dynamic'

/** Returns the caller to their own invite link, so a mistyped password does not burn the invite. */
function formFailureRedirect(inviteToken: string | undefined): Response {
  const destination = new URL(SIGNUP_PATH, 'http://placeholder.invalid')
  if (inviteToken !== undefined) destination.searchParams.set(INVITE_TOKEN_PARAMETER, inviteToken)
  destination.searchParams.set('error', 'invalid')
  return seeOther(`${destination.pathname}${destination.search}`)
}

export async function POST(request: Request): Promise<Response> {
  const returnsJson = wantsJsonResponse(request)
  let submittedToken: string | undefined

  try {
    enforceAuthRateLimit(request, 'signup')

    const body = await readRequestBody(request)
    const parsed = signupSchema.safeParse(body)
    if (!parsed.success) {
      throw new HttpError(
        'VALIDATION_FAILED',
        'Enter a valid email and a password of at least 12 characters',
      )
    }
    submittedToken = parsed.data.inviteToken

    const member = await registerMember(parsed.data, clientIpFromHeaders(request.headers))
    return seeOther('/dashboard', { 'set-cookie': await createSessionCookie(member.id) })
  } catch (error) {
    if (returnsJson) return toErrorResponse(error)
    return formFailureRedirect(submittedToken)
  }
}
