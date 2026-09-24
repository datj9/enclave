/**
 * Fixed-window counter, in-process. Enough for the per-IP auth limit this slice needs
 * (grill-result §8: login rate-limited per email and per IP) and for later slices to reuse
 * on any non-generation endpoint.
 *
 * In-process means the limit is per app replica. Generation quotas, which must hold across
 * replicas, are counted in Postgres instead — that is S7's `usage_counters`, not this module.
 */

import { env } from '@/env'

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

/**
 * A Map iterates in insertion order, and every new window is a fresh `set` after a `delete`, so
 * the first entry is always the window that started longest ago — which is what makes
 * oldest-first eviction a single `keys().next()`.
 */
const windowsByKey = new Map<string, Window>()

/**
 * Bounds memory when keys are attacker-controlled (one per source IP, one per typed email).
 * A hard cap, not a hint: once expired windows are gone, the oldest live one is dropped. That
 * forgives a stale counter under a flood of distinct keys, which is the right trade — the
 * alternative is unbounded growth until the process dies, and that locks everyone out.
 */
export const MAX_TRACKED_KEYS = 10_000

function evictExpired(nowMs: number): void {
  for (const [key, window] of windowsByKey) {
    if (window.resetAtMs <= nowMs) windowsByKey.delete(key)
  }
}

function evictOldestUntilBelowCap(): void {
  while (windowsByKey.size >= MAX_TRACKED_KEYS) {
    const oldest = windowsByKey.keys().next()
    if (oldest.done === true) return
    windowsByKey.delete(oldest.value)
  }
}

export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  nowMs: number = Date.now(),
): RateLimitResult {
  const existing = windowsByKey.get(key)

  if (existing === undefined || existing.resetAtMs <= nowMs) {
    // Delete first so a restarted window moves to the back of the insertion order.
    windowsByKey.delete(key)
    if (windowsByKey.size >= MAX_TRACKED_KEYS) evictExpired(nowMs)
    evictOldestUntilBelowCap()
    windowsByKey.set(key, { count: 1, resetAtMs: nowMs + rule.windowSeconds * 1000 })
    return { allowed: true, remaining: rule.limit - 1 }
  }

  if (existing.count >= rule.limit) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
    }
  }

  // Mutated in place rather than re-set: a re-set would keep the key's position anyway, and the
  // position must reflect when the window started, not when it was last hit.
  existing.count += 1
  return { allowed: true, remaining: rule.limit - existing.count }
}

/** Test-only: how many windows are held. There is no production caller. */
export function trackedRateLimitKeyCount(): number {
  return windowsByKey.size
}

/** Test-only reset; there is no production caller. */
export function resetRateLimits(): void {
  windowsByKey.clear()
}

/**
 * `203.0.113.7:51234` and `[2001:db8::7]:51234` — some load balancers (Azure Application Gateway
 * among them) append the source port — become the bare address. Otherwise every new connection
 * would be a fresh rate-limit key, and the audit log's `inet` column would drop the value.
 */
function withoutPort(hop: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(hop)
  if (bracketed?.[1] !== undefined) return bracketed[1]
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(hop)
  return ipv4WithPort?.[1] ?? hop
}

/**
 * The client address as the trusted proxy chain saw it.
 *
 * `x-forwarded-for` is appended to by each proxy (nginx `$proxy_add_x_forwarded_for`), so only
 * the entries the operator's own proxies wrote are trustworthy, and those are at the RIGHT end.
 * Anything to their left was supplied by the caller and can be anything. `TRUSTED_PROXY_HOPS`
 * says how many proxies sit in front of the app: 1 for a single nginx/Caddy/Traefik, 2 for a CDN
 * in front of that proxy, and so on — the client is the entry that many places from the right.
 *
 * Fewer entries than hops means the request skipped part of the chain the operator described;
 * the leftmost entry is then the best available guess, and the self-hosting guide says the app
 * must not be reachable except through the proxy.
 */
export function clientIpFromHeaders(
  headers: Headers,
  trustedProxyHops: number = env.TRUSTED_PROXY_HOPS,
): string {
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '')

  if (hops.length > 0) {
    // A mocked or partial env can hand us undefined; one hop is the documented default.
    const trusted =
      Number.isInteger(trustedProxyHops) && trustedProxyHops >= 1 ? trustedProxyHops : 1
    const index = Math.max(0, hops.length - trusted)
    return withoutPort(hops[index] ?? 'unknown')
  }
  const realIp = headers.get('x-real-ip')?.trim() ?? ''
  return realIp === '' ? 'unknown' : withoutPort(realIp)
}
