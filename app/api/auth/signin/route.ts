import { requireSameOriginRequest } from '@/lib/api/guards'
import { recordAuditEvent } from '@/lib/audit'
import {
  GENERIC_SIGNIN_FAILURE,
  authenticateWithPassword,
  credentialsSchema,
} from '@/lib/auth/credentials'
import { enforceAuthRateLimit, enforceSigninEmailRateLimit } from '@/lib/auth/rate-limit-auth'
import { createSessionCookie } from '@/lib/auth/session'
import { HttpError, seeOther, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOriginRequest(request)
  } catch (error) {
    return toErrorResponse(error)
  }
  const returnsJson = wantsJsonResponse(request)
  const clientIp = clientIpFromHeaders(request.headers)

  try {
    enforceAuthRateLimit(request, 'signin')

    const parsed = credentialsSchema.safeParse(await readRequestBody(request))
    if (!parsed.success) {
      // Same message and status as a wrong password: a malformed body must not reveal that
      // the email was well-formed but unknown.
      recordAuditEvent({
        action: 'auth.login_failed',
        actorIp: clientIp,
        metadata: { reason: 'malformed' },
      })
      throw new HttpError('UNAUTHENTICATED', GENERIC_SIGNIN_FAILURE)
    }

    // After parsing, so only a well-formed address gets a counter; before verifying, so a locked
    // address costs no argon2 work. The 429 is the same whether or not the account exists.
    enforceSigninEmailRateLimit(parsed.data.email)

    const outcome = await authenticateWithPassword(parsed.data)
    if (!outcome.ok) {
      recordAuditEvent({
        action: 'auth.login_failed',
        actorIp: clientIp,
        metadata: { reason: 'invalid_credentials' },
      })
      throw new HttpError('UNAUTHENTICATED', GENERIC_SIGNIN_FAILURE)
    }

    recordAuditEvent({ action: 'auth.login', actorUserId: outcome.userId, actorIp: clientIp })
    return seeOther('/dashboard', { 'set-cookie': await createSessionCookie(outcome.userId) })
  } catch (error) {
    if (returnsJson) return toErrorResponse(error)
    return seeOther('/signin?error=invalid')
  }
}
