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
 * rotating IPs still cannot hammer one address. A counter caps volume, not timing: the detached
 * delivery in `forgot-password.ts` is what keeps the two branches equally fast.
 */
export function enforceForgotPasswordEmailRateLimit(normalizedEmail: string): void {
  enforceLimit(`auth:forgot-password-email:${normalizedEmail}`)
}

/**
 * Per-email cap on password sign-in, independent of the per-IP cap: an attacker spraying one
 * account from many addresses still meets a ceiling. Lowercased here as well as by the caller's
 * schema so the counter can never be split by case, whatever path reaches it.
 *
 * The trade-off is deliberate: anyone can burn a known address's budget and lock its password
 * sign-in for up to an hour. That is a nuisance bounded by the window; unlimited guessing is not.
 */
export function enforceSigninEmailRateLimit(email: string): void {
  enforceLimit(`auth:signin-email:${email.trim().toLowerCase()}`)
}

/**
 * Per-user cap on change-password, independent of the per-IP cap so an attacker with the same
 * IP cannot lock out every user in the same building.
 */
export function enforceChangePasswordUserRateLimit(userId: string): void {
  enforceLimit(`auth:change-password-user:${userId}`)
}
