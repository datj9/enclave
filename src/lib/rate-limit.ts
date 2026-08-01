/**
 * Fixed-window counter, in-process. Enough for the per-IP auth limit this slice needs
 * (grill-result §8: login rate-limited per email and per IP) and for later slices to reuse
 * on any non-generation endpoint.
 *
 * In-process means the limit is per app replica. Generation quotas, which must hold across
 * replicas, are counted in Postgres instead — that is S7's `usage_counters`, not this module.
 */

export interface RateLimitRule {
  readonly limit: number
  readonly windowSeconds: number
}

export type RateLimitResult =
  | { readonly allowed: true; readonly remaining: number }
  | { readonly allowed: false; readonly retryAfterSeconds: number }

interface Window {
  count: number
  resetAtMs: number
}

const windowsByKey = new Map<string, Window>()

/** Bounds memory when keys are attacker-controlled (one per source IP). */
const MAX_TRACKED_KEYS = 10_000

function evictExpired(nowMs: number): void {
  for (const [key, window] of windowsByKey) {
    if (window.resetAtMs <= nowMs) windowsByKey.delete(key)
  }
}

export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  nowMs: number = Date.now(),
): RateLimitResult {
  const existing = windowsByKey.get(key)

  if (existing === undefined || existing.resetAtMs <= nowMs) {
    if (windowsByKey.size >= MAX_TRACKED_KEYS) evictExpired(nowMs)
    windowsByKey.set(key, { count: 1, resetAtMs: nowMs + rule.windowSeconds * 1000 })
    return { allowed: true, remaining: rule.limit - 1 }
  }

  if (existing.count >= rule.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
    }
  }

  const nextCount = existing.count + 1
  windowsByKey.set(key, { ...existing, count: nextCount })
  return { allowed: true, remaining: rule.limit - nextCount }
}

/** Test-only reset; there is no production caller. */
export function resetRateLimits(): void {
  windowsByKey.clear()
}

/**
 * Trusts `x-forwarded-for` because every supported deployment terminates TLS at a proxy.
 * A direct-to-Node deployment must not be exposed without one — documented in self-hosting.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const forwardedFor = headers.get('x-forwarded-for')
  const firstHop = forwardedFor?.split(',')[0]?.trim()
  if (firstHop !== undefined && firstHop !== '') return firstHop
  return headers.get('x-real-ip') ?? 'unknown'
}
