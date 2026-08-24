import { beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '@/lib/http'
import { clientIpFromHeaders, consumeRateLimit, resetRateLimits } from '@/lib/rate-limit'
import {
  enforceAuthRateLimit,
  enforceChangePasswordUserRateLimit,
  enforceForgotPasswordEmailRateLimit,
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
})

describe('clientIpFromHeaders', () => {
  it('takes the first hop of x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' })

    expect(clientIpFromHeaders(headers)).toBe('203.0.113.7')
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
