import { beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/lib/http'
import {
  MAX_TRACKED_KEYS,
  clientIpFromHeaders,
  consumeRateLimit,
  resetRateLimits,
  trackedRateLimitKeyCount,
} from '@/lib/rate-limit'
import {
  enforceAuthRateLimit,
  enforceChangePasswordUserRateLimit,
  enforceForgotPasswordEmailRateLimit,
  enforceSigninEmailRateLimit,
} from '@/lib/auth/rate-limit-auth'

const RULE = { limit: 3, windowSeconds: 60 } as const

beforeEach(() => {
  resetRateLimits()
})

describe('consumeRateLimit', () => {
  it('allows calls up to the limit and reports the remaining budget', () => {
    expect(consumeRateLimit('ip:1', RULE, 0)).toEqual({ allowed: true, remaining: 2 })
    expect(consumeRateLimit('ip:1', RULE, 1)).toEqual({ allowed: true, remaining: 1 })
    expect(consumeRateLimit('ip:1', RULE, 2)).toEqual({ allowed: true, remaining: 0 })
  })

  it('denies the call after the limit with seconds until the window resets', () => {
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('ip:1', RULE, 0)

    expect(consumeRateLimit('ip:1', RULE, 0)).toEqual({ allowed: false, retryAfterSeconds: 60 })
    expect(consumeRateLimit('ip:1', RULE, 30_000)).toEqual({
      allowed: false,
      retryAfterSeconds: 30,
    })
  })

  it('never reports a retry-after below one second', () => {
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('ip:1', RULE, 0)

    expect(consumeRateLimit('ip:1', RULE, 59_999)).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })

  it('starts a fresh window once the old one has elapsed', () => {
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('ip:1', RULE, 0)

    expect(consumeRateLimit('ip:1', RULE, 60_000)).toEqual({ allowed: true, remaining: 2 })
  })

  it('counts each key independently', () => {
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('ip:1', RULE, 0)

    expect(consumeRateLimit('ip:2', RULE, 0)).toEqual({ allowed: true, remaining: 2 })
  })

  it('never holds more than the cap, even when every window is still live', () => {
    for (let index = 0; index < MAX_TRACKED_KEYS + 50; index += 1) {
      consumeRateLimit(`flood:${index}`, RULE, 0)
    }

    expect(trackedRateLimitKeyCount()).toBe(MAX_TRACKED_KEYS)
  })

  it('evicts the oldest live window first when full', () => {
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('oldest', RULE, 0)
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('newest', RULE, 1)
    for (let index = 0; index < MAX_TRACKED_KEYS - 2; index += 1) {
      consumeRateLimit(`filler:${index}`, RULE, 2)
    }

    // One more key tips it over: 'oldest' goes, 'newest' keeps its exhausted window.
    consumeRateLimit('one-more', RULE, 3)

    expect(consumeRateLimit('newest', RULE, 4)).toMatchObject({ allowed: false })
    expect(consumeRateLimit('oldest', RULE, 4)).toEqual({ allowed: true, remaining: 2 })
  })

  it('prefers dropping expired windows over live ones', () => {
    consumeRateLimit('expired', { limit: 3, windowSeconds: 1 }, 0)
    for (let attempt = 0; attempt < RULE.limit; attempt += 1) consumeRateLimit('live', RULE, 0)
    for (let index = 0; index < MAX_TRACKED_KEYS - 2; index += 1) {
      consumeRateLimit(`filler:${index}`, RULE, 0)
    }

    consumeRateLimit('one-more', RULE, 5_000)

    expect(consumeRateLimit('live', RULE, 5_000)).toMatchObject({ allowed: false })
    expect(trackedRateLimitKeyCount()).toBe(MAX_TRACKED_KEYS)
  })
})

describe('clientIpFromHeaders', () => {
  it('takes the rightmost entry by default — the one a single proxy appended', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 198.51.100.4' })

    expect(clientIpFromHeaders(headers)).toBe('198.51.100.4')
  })

  it('ignores a spoofed leftmost entry the caller supplied', () => {
    // What nginx forwards when the client sent `X-Forwarded-For: 1.2.3.4` itself.
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.4' })

    expect(clientIpFromHeaders(headers, 1)).toBe('198.51.100.4')
  })

  it('counts TRUSTED_PROXY_HOPS entries from the right for a CDN in front of the proxy', () => {
    // client-supplied, real client (added by the CDN), CDN edge (added by nginx).
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 104.16.0.1' })

    expect(clientIpFromHeaders(headers, 2)).toBe('203.0.113.7')
  })

  it('takes the leftmost entry when the chain is shorter than the configured hops', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7' }), 3)).toBe(
      '203.0.113.7',
    )
  })

  it('skips blank entries and surrounding whitespace', () => {
    const headers = new Headers({ 'x-forwarded-for': ' 203.0.113.7 ,, 198.51.100.4 , ' })

    expect(clientIpFromHeaders(headers, 1)).toBe('198.51.100.4')
  })

  it('treats a missing or invalid hop count as one hop', () => {
    const headers = new Headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.4' })

    expect(clientIpFromHeaders(headers, Number.NaN)).toBe('198.51.100.4')
    expect(clientIpFromHeaders(headers, 0)).toBe('198.51.100.4')
  })

  it('drops a source port some load balancers append, so each connection is not a new key', () => {
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7:51234' }), 1),
    ).toBe('203.0.113.7')
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '[2001:db8::7]:51234' }), 1)).toBe(
      '2001:db8::7',
    )
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '2001:db8::7' }), 1)).toBe(
      '2001:db8::7',
    )
  })

  it('falls back to x-real-ip', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9')
  })

  it('returns a placeholder rather than throwing when no header is present', () => {
    expect(clientIpFromHeaders(new Headers())).toBe('unknown')
  })

  it('ignores an empty x-forwarded-for', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '' }))).toBe('unknown')
  })
})

describe('enforceAuthRateLimit', () => {
  function requestFrom(ip: string): Request {
    return new Request('http://localhost:3000/api/auth/signin', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
    })
  }

  it('allows attempts under the configured per-IP cap', () => {
    expect(() => enforceAuthRateLimit(requestFrom('203.0.113.7'), 'signin')).not.toThrow()
  })

  it('throws RATE_LIMITED with a Retry-After header once the cap is reached', () => {
    const request = requestFrom('203.0.113.8')
    // RATE_LIMIT_AUTH_PER_IP_PER_HOUR defaults to 30.
    for (let attempt = 0; attempt < 30; attempt += 1) enforceAuthRateLimit(request, 'signin')

    let caught: unknown
    try {
      enforceAuthRateLimit(request, 'signin')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).code).toBe('RATE_LIMITED')
    expect((caught as HttpError).status).toBe(429)
    expect((caught as HttpError).headers['retry-after']).toMatch(/^\d+$/)
  })

  it('keeps setup and signin on separate counters', () => {
    const request = requestFrom('203.0.113.9')
    for (let attempt = 0; attempt < 30; attempt += 1) enforceAuthRateLimit(request, 'signin')

    expect(() => enforceAuthRateLimit(request, 'setup')).not.toThrow()
  })

  it('keeps forgot-password and signin on separate counters', () => {
    const request = requestFrom('203.0.113.10')
    for (let attempt = 0; attempt < 30; attempt += 1) enforceAuthRateLimit(request, 'signin')

    expect(() => enforceAuthRateLimit(request, 'forgot-password')).not.toThrow()
  })

  it('keeps change-password and signin on separate counters', () => {
    const request = requestFrom('203.0.113.11')
    for (let attempt = 0; attempt < 30; attempt += 1) enforceAuthRateLimit(request, 'signin')

    expect(() => enforceAuthRateLimit(request, 'change-password')).not.toThrow()
  })
})

describe('enforceChangePasswordUserRateLimit', () => {
  it('caps change-password per user independently of IP', () => {
    enforceChangePasswordUserRateLimit('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    for (let attempt = 0; attempt < 29; attempt += 1) {
      enforceChangePasswordUserRateLimit('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    }

    let caught: unknown
    try {
      enforceChangePasswordUserRateLimit('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).code).toBe('RATE_LIMITED')
    expect((caught as HttpError).status).toBe(429)
    expect((caught as HttpError).headers['retry-after']).toMatch(/^\d+$/)

    expect(() =>
      enforceChangePasswordUserRateLimit('22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    ).not.toThrow()
  })
})

describe('enforceForgotPasswordEmailRateLimit', () => {
  it('caps forgot-password per normalised email independently of IP', () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      enforceForgotPasswordEmailRateLimit('ops@example.com')
    }

    let caught: unknown
    try {
      enforceForgotPasswordEmailRateLimit('ops@example.com')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).code).toBe('RATE_LIMITED')
    expect((caught as HttpError).status).toBe(429)

    expect(() => enforceForgotPasswordEmailRateLimit('nobody@example.com')).not.toThrow()
  })
})

describe('enforceSigninEmailRateLimit', () => {
  it('caps sign-in per email independently of IP', () => {
    for (let attempt = 0; attempt < 30; attempt += 1) enforceSigninEmailRateLimit('ops@example.com')

    let caught: unknown
    try {
      enforceSigninEmailRateLimit('ops@example.com')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HttpError)
    expect((caught as HttpError).code).toBe('RATE_LIMITED')
    expect((caught as HttpError).status).toBe(429)
    expect(() => enforceSigninEmailRateLimit('someone-else@example.com')).not.toThrow()
  })

  it('shares one counter across differently-cased spellings of an address', () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      enforceSigninEmailRateLimit(attempt % 2 === 0 ? 'Ops@Example.com' : 'ops@example.com ')
    }

    expect(() => enforceSigninEmailRateLimit('OPS@EXAMPLE.COM')).toThrow(HttpError)
  })

  it('does not share a counter with forgot-password for the same address', () => {
    for (let attempt = 0; attempt < 30; attempt += 1) enforceSigninEmailRateLimit('ops@example.com')

    expect(() => enforceForgotPasswordEmailRateLimit('ops@example.com')).not.toThrow()
  })
})
