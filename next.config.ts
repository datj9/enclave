import type { NextConfig } from 'next'

// Security headers are NOT configured here. A `headers()` rule matches on path only, and S3
// serves two origins from one process (grill-result §4.1) whose header sets differ — the app's
// `X-Frame-Options: DENY` on an artifact response would block the viewer's own iframe. Both
// sets are emitted per-host from proxy.ts instead, which also keeps them out of the
// build-time routes manifest that a self-hosted image would otherwise freeze.

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
  // Only the Docker image wants a standalone bundle. Setting it unconditionally makes
  // `next start` warn and serve from the wrong place, which breaks `pnpm test:e2e` locally.
  ...(process.env.BUILD_STANDALONE === 'true' ? { output: 'standalone' as const } : {}),
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    proxyClientMaxBodySize: requestBodyCeilingBytes(),
  },
}

export default nextConfig
