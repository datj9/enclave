import type { NextConfig } from 'next'

// Static app-origin headers per grill-result §4.3. The Content-Security-Policy is NOT here:
// it carries a per-request nonce, so it is emitted from middleware.ts instead.
const APP_SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
] as const

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  headers: async () => [{ source: '/:path*', headers: [...APP_SECURITY_HEADERS] }],
}

export default nextConfig
