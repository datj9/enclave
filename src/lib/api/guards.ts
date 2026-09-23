import { appOrigin, requestHost } from '@/lib/artifacts/origin'
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

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * `none` is a user-initiated request (address bar, bookmark). Everything else — `same-site`
 * above all — is refused: artifact origins are `{id}.artifacts.<app domain>`, the same *site* as
 * the app, so `SameSite=Lax` alone still attaches the session cookie to a POST that untrusted
 * artifact JavaScript sends to the app.
 */
const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none'])

/**
 * A browser attaches `Authorization` cross-origin only after a CORS preflight, and the app
 * answers no preflight, so a bearer header means the request was not forged by another page.
 * The token itself is validated by `requireApiPrincipal`; this only decides whether the origin
 * check applies.
 */
function carriesBearerCredential(headers: Headers): boolean {
  return /^bearer\s+\S/i.test(headers.get('authorization')?.trim() ?? '')
}

function isTrustedOrigin(origin: string, request: Request): boolean {
  // `Origin: null` (sandboxed frames, opaque redirects) never names the app, so it cannot pass.
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.origin === appOrigin()) return true
  // A deployment reached on a host other than APP_URL (a LAN name, the e2e harness on
  // 127.0.0.1) is still same-origin with itself. Parsed with the Origin's scheme so a proxy that
  // writes the default port into Host (`app.example.com:443`) still matches the browser's Origin,
  // which never carries one.
  const host = requestHost(request)
  if (host === null || /[/\\@?#]/.test(host)) return false
  try {
    return new URL(`${parsed.protocol}//${host}`).origin === parsed.origin
  } catch {
    return false
  }
}

/**
 * The CSRF gate for every cookie-authenticated state change (§8). Refuses an unsafe method
 * unless the browser says the request came from the app itself: `Sec-Fetch-Site`, when sent,
 * must be `same-origin` or `none`, and `Origin`, when sent, must be the app's.
 *
 * Both headers are optional on purpose. Non-browser clients (the CLI, curl, Playwright's
 * `request` fixture, the integration suite) send neither and hold no ambient cookie a third party
 * could ride, while every current browser sets `Origin` on a cross-origin POST.
 */
export function requireSameOriginRequest(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return
  if (carriesBearerCredential(request.headers)) return

  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? ''
  const origin = request.headers.get('origin')

  const fetchSiteAllowed = fetchSite === '' || ALLOWED_FETCH_SITES.has(fetchSite)
  const originAllowed = origin === null || isTrustedOrigin(origin, request)

  if (!fetchSiteAllowed || !originAllowed) {
    throw new HttpError('FORBIDDEN', 'Cross-site requests are not allowed')
  }
}

/** `Application/JSON; charset=utf-8` → `application/json`: the MIME essence (RFC 9110 §8.3.1). */
function mimeEssence(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Every JSON write route calls this, so it also carries the origin check and no route has to
 * remember a second guard. The essence must be exactly `application/json`: the substring match it
 * replaces accepted `text/plain;application/json`, which any page can send as a CORS-simple
 * request with no preflight.
 */
export function requireJsonContentType(request: Request): void {
  requireSameOriginRequest(request)

  if (mimeEssence(request.headers.get('content-type') ?? '') !== 'application/json') {
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
