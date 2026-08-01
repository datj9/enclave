import { NextResponse, type NextRequest } from 'next/server'

import {
  ARTIFACT_ENTER_PATH,
  ARTIFACT_ROUTE_PREFIX,
  appOrigin,
  artifactIdFromHost,
  artifactOriginPattern,
  requestHost,
} from '@/lib/artifacts/origin'

/**
 * `proxy.ts` is Next 16's name for what used to be `middleware.ts`. It is the only place that
 * decides which of grill-result §4.1's two origins a request belongs to, and it is where both
 * origins' §4.3 response headers are set — including the app's, which must NOT reach the
 * artifact origin: `X-Frame-Options: DENY` there would block the viewer's own iframe.
 *
 * A proxy always runs on the Node.js runtime, so `env` is read from the real process
 * environment at request time — a self-hosted image configured through `.env` gets its
 * `ARTIFACT_ORIGIN_TEMPLATE` honoured rather than a value frozen at build time.
 */

const isDevelopment = process.env.NODE_ENV !== 'production'

const APP_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['strict-transport-security', 'max-age=63072000; includeSubDomains'],
]

// 'strict-dynamic' lets the nonced Next.js bootstrap load its own chunks without listing
// every hashed filename. 'unsafe-eval' is dev-only — the React refresh runtime needs it.
function appContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${isDevelopment ? ' ws:' : ''}`,
    // The viewer frames one artifact origin per artifact, so the source has to be the wildcard.
    `frame-src ${artifactOriginPattern()}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/**
 * grill-result §4.3, verbatim. `unsafe-inline` and `unsafe-eval` are deliberate: artifacts are
 * React-via-import-map documents and cannot run without them. That is acceptable only because
 * this origin holds nothing but a grant cookie scoped to the single artifact it serves.
 */
function artifactContentSecurityPolicy(): string {
  return [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    'img-src * data: blob:',
    'connect-src *',
    `frame-ancestors ${appOrigin()}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
}

function withArtifactHeaders(response: NextResponse): NextResponse {
  response.headers.set('content-security-policy', artifactContentSecurityPolicy())
  response.headers.set('x-content-type-options', 'nosniff')
  response.headers.set('cross-origin-resource-policy', 'same-site')
  return response
}

/**
 * Every path on an artifact origin is rewritten, `/artifact-origin/…` included, so there is no
 * request shape that reaches the internal routes without going through this mapping.
 */
function handleArtifactOrigin(request: NextRequest, artifactId: string): NextResponse {
  const { pathname } = request.nextUrl
  const base = `${ARTIFACT_ROUTE_PREFIX}/${artifactId}`

  const rewritten = request.nextUrl.clone()
  rewritten.pathname =
    pathname === ARTIFACT_ENTER_PATH
      ? `${base}/enter`
      : `${base}/serve${pathname === '/' ? '' : pathname}`

  return withArtifactHeaders(NextResponse.rewrite(rewritten))
}

function handleAppOrigin(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith(ARTIFACT_ROUTE_PREFIX)) {
    return new NextResponse(null, { status: 404 })
  }

  const nonce = crypto.randomUUID()
  const contentSecurityPolicy = appContentSecurityPolicy(nonce)

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', contentSecurityPolicy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', contentSecurityPolicy)
  for (const [name, value] of APP_SECURITY_HEADERS) response.headers.set(name, value)
  return response
}

export function proxy(request: NextRequest): NextResponse {
  const artifactId = artifactIdFromHost(requestHost(request))
  return artifactId === null
    ? handleAppOrigin(request)
    : handleArtifactOrigin(request, artifactId)
}

export const config = {
  // Everything, `_next/static` included: on an artifact origin those paths must resolve against
  // that artifact's manifest and 404, not serve the app's own chunks from a sandboxed origin.
  matcher: ['/((?!_next/image|_next/webpack-hmr).*)'],
}
