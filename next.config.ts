import type { NextConfig } from 'next'

// Static app-origin headers per grill-result §4.3. The Content-Security-Policy is NOT here:
// it carries a per-request nonce, so it is emitted from middleware.ts instead.
const APP_SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
] as const

const DEFAULT_BUNDLE_MAX_TOTAL_BYTES = 10_485_760
const BASE64_OVERHEAD = 4 / 3
const JSON_ENVELOPE_SLACK_BYTES = 1_048_576

/**
 * The request-body ceiling has to sit above the largest legal bundle on the wire, or Next
 * truncates the body and `POST /api/v1/artifacts` answers `422` for a malformed body where S2
 * requires `413 BUNDLE_TOO_LARGE`. Keeping this one step above `BUNDLE_MAX_TOTAL_BYTES` leaves
 * the bundle validator as the only thing that rejects an oversize bundle — but still a hard cap.
 *
 * `contentBase64` inflates by 4/3, plus the JSON envelope's paths and escaping.
 */
function requestBodyCeilingBytes(): number {
  const configured = Number(process.env.BUNDLE_MAX_TOTAL_BYTES)
  const maxTotalBytes = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_BUNDLE_MAX_TOTAL_BYTES

  return Math.ceil(maxTotalBytes * BASE64_OVERHEAD) + JSON_ENVELOPE_SLACK_BYTES
}

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  headers: async () => [{ source: '/:path*', headers: [...APP_SECURITY_HEADERS] }],
  experimental: {
    proxyClientMaxBodySize: requestBodyCeilingBytes(),
  },
}

export default nextConfig
