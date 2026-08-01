import { getSessionUser, type SessionUser } from '@/lib/auth/session'
import { HttpError } from '@/lib/http'

/**
 * Guards shared by the `/api/v1` routes. Session-only in S2; S8 adds bearer-token resolution
 * beside `requireSessionUser` and both collapse into one `Viewer` for `canRead` (§5.1).
 */

export async function requireSessionUser(): Promise<SessionUser> {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) throw new HttpError('UNAUTHENTICATED', 'Sign in to continue')
  return sessionUser
}

/**
 * A JSON-only write surface is also the CSRF mitigation: an `application/json` request is not a
 * simple cross-site form post, so `SameSite=Lax` plus this check covers §8 without a token.
 */
export function requireJsonContentType(request: Request): void {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new HttpError('VALIDATION_FAILED', 'Send a JSON body with content-type application/json')
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError('VALIDATION_FAILED', 'Request body is not valid JSON')
  }
}
