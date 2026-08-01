import { NextResponse, type NextRequest } from 'next/server'

const isDevelopment = process.env.NODE_ENV !== 'production'

// 'strict-dynamic' lets the nonced Next.js bootstrap load its own chunks without listing
// every hashed filename. 'unsafe-eval' is dev-only — the React refresh runtime needs it.
function buildContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${isDevelopment ? ' ws:' : ''}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

/**
 * `proxy.ts` is Next 16's name for what used to be `middleware.ts` — the older convention
 * still works but logs a deprecation warning. S3 adds host-based artifact-origin routing here.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID()
  const contentSecurityPolicy = buildContentSecurityPolicy(nonce)

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', contentSecurityPolicy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', contentSecurityPolicy)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
