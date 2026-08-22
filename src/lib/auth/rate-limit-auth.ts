import { env } from '@/env'
import { HttpError } from '@/lib/http'
import { clientIpFromHeaders, consumeRateLimit } from '@/lib/rate-limit'

const ONE_HOUR_SECONDS = 3600

function enforceLimit(key: string): void {
  const outcome = consumeRateLimit(key, {
    limit: env.RATE_LIMIT_AUTH_PER_IP_PER_HOUR,
    windowSeconds: ONE_HOUR_SECONDS,
  })

  if (!outcome.allowed) {
    throw new HttpError('RATE_LIMITED', 'Too many attempts, please try again later', {
      headers: { 'retry-after': String(outcome.retryAfterSeconds) },
    })
  }
}

/**
 * Per-IP cap on the unauthenticated auth surface (§8: login rate-limited per email and per IP).
 * `scope` keeps /setup and /signin on separate counters so hammering one does not lock the other.
 * Later slices reuse this on any route that accepts credentials or tokens.
 */
export function enforceAuthRateLimit(request: Request, scope: string): void {
  enforceLimit(`auth:${scope}:${clientIpFromHeaders(request.headers)}`)
}

/**
 * Per-normalised-email cap on forgot-password, independent of the per-IP cap so an attacker
 * rotating IPs still cannot gauge an address's existence from response timing.
 */
export function enforceForgotPasswordEmailRateLimit(normalizedEmail: string): void {
  enforceLimit(`auth:forgot-password-email:${normalizedEmail}`)
}
