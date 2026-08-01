import {
  AuthorizationResponseError,
  ClientError,
  ResponseBodyError,
  WWWAuthenticateChallengeError,
} from 'openid-client'
import { recordAuditEvent } from '@/lib/audit'
import {
  callbackUrlFromRequest,
  clearTransactionCookie,
  exchangeAuthorizationCode,
  isOidcEnabled,
  openTransaction,
  readTransactionCookie,
  rejectionError,
  resolveOidcIdentity,
  stateMatches,
  verificationFailed,
  type OidcIdentity,
  type OidcRejection,
} from '@/lib/auth/oidc'
import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { createSessionCookie } from '@/lib/auth/session'
import { HttpError, jsonError, seeOther, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/** `unverified` covers every state, nonce, PKCE, signature and expiry failure alike. */
type CallbackFailure = OidcRejection | 'unverified'

type CallbackResult =
  | { readonly ok: true; readonly userId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: CallbackFailure }

/** Every response from here drops the in-flight cookie, so a stale one cannot be replayed. */
function withClearedTransaction(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.append('set-cookie', clearTransactionCookie())
  return new Response(response.body, { status: response.status, headers })
}

function signedInResponse(sessionCookie: string): Response {
  const headers = new Headers({ location: '/dashboard' })
  headers.append('set-cookie', sessionCookie)
  headers.append('set-cookie', clearTransactionCookie())
  return new Response(null, { status: 303, headers })
}

/** A provider-side validation failure is the caller's problem: 400, never a session. */
function isProviderValidationFailure(error: unknown): boolean {
  return (
    error instanceof ClientError ||
    error instanceof AuthorizationResponseError ||
    error instanceof ResponseBodyError ||
    error instanceof WWWAuthenticateChallengeError
  )
}

function failureResponse(reason: CallbackFailure): Response {
  const error = reason === 'unverified' ? verificationFailed() : rejectionError(reason)
  return withClearedTransaction(toErrorResponse(error))
}

async function claimIdentity(
  callbackUrl: URL,
  transaction: Awaited<ReturnType<typeof openTransaction>>,
): Promise<OidcIdentity | null> {
  if (transaction === null) return null
  if (!stateMatches(callbackUrl.searchParams.get('state'), transaction.state)) return null

  try {
    return await exchangeAuthorizationCode(callbackUrl, transaction)
  } catch (error) {
    if (error instanceof HttpError) return null
    if (isProviderValidationFailure(error)) return null
    // Discovery or the token endpoint is unreachable — a genuine 500, not a rejected caller.
    throw error
  }
}

async function completeSignin(request: Request): Promise<CallbackResult> {
  const callbackUrl = callbackUrlFromRequest(request)
  const transaction = await openTransaction(readTransactionCookie(request))

  const identity = await claimIdentity(callbackUrl, transaction)
  if (identity === null) return { ok: false, reason: 'unverified' }

  const outcome = await resolveOidcIdentity(identity)
  if (!outcome.ok) return { ok: false, reason: outcome.reason }
  return { ok: true, userId: outcome.userId, created: outcome.created }
}

export async function GET(request: Request): Promise<Response> {
  if (!isOidcEnabled()) return jsonError('NOT_FOUND', 'Not found')

  const clientIp = clientIpFromHeaders(request.headers)

  try {
    enforceAuthRateLimit(request, 'oidc-callback')

    // The provider declined — a cancelled consent screen is the common case. Not worth a status
    // code of its own, just put the visitor back on the form.
    if (new URL(request.url).searchParams.has('error')) {
      return withClearedTransaction(seeOther('/signin?error=oidc'))
    }

    const result = await completeSignin(request)
    if (!result.ok) {
      recordAuditEvent({
        action: 'auth.login_failed',
        actorIp: clientIp,
        metadata: { provider: 'oidc', reason: result.reason },
      })
      return failureResponse(result.reason)
    }

    if (result.created) {
      recordAuditEvent({ action: 'user.create', actorUserId: result.userId, actorIp: clientIp })
    }
    recordAuditEvent({
      action: 'auth.login',
      actorUserId: result.userId,
      actorIp: clientIp,
      metadata: { provider: 'oidc' },
    })
    return signedInResponse(await createSessionCookie(result.userId))
  } catch (error) {
    return withClearedTransaction(toErrorResponse(error))
  }
}
