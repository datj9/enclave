import { describe, expect, it } from 'vitest'

import { decideQuota, utcWindowDate, type QuotaUsage } from '@/lib/quota'

/**
 * The decision half of §5.7, without a database. The counter arithmetic against real rows is
 * covered by tests/integration/generation-quota.test.ts.
 */

const NOW = new Date('2026-08-01T12:00:00.000Z')
const HOUR_SECONDS = 3600

function usageWith(overrides: Partial<QuotaUsage> = {}): QuotaUsage {
  return {
    hourlyCount: 0,
    hourlyLimit: 2,
    hourlySlotFreesAt: undefined,
    dailyCount: 0,
    dailyLimit: 100,
    ...overrides,
  }
}

describe('decideQuota', () => {
  it('allows the call at n - 1, the last one under the hourly limit', () => {
    expect(decideQuota(usageWith({ hourlyCount: 1 }), NOW)).toEqual({ allowed: true })
  })

  it('denies the call at n with RATE_LIMITED', () => {
    const freesAt = new Date(NOW.getTime() + 2280 * 1000)

    expect(decideQuota(usageWith({ hourlyCount: 2, hourlySlotFreesAt: freesAt }), NOW)).toEqual({
      allowed: false,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 2280,
    })
  })

  it('keeps denying past the limit, and waits for the row that frees a slot', () => {
    const freesAt = new Date(NOW.getTime() + 30 * 1000)

    expect(decideQuota(usageWith({ hourlyCount: 9, hourlySlotFreesAt: freesAt }), NOW)).toEqual({
      allowed: false,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    })
  })

  it('falls back to a full hour when the freeing row cannot be identified', () => {
    const decision = decideQuota(usageWith({ hourlyCount: 2 }), NOW)

    expect(decision).toEqual({
      allowed: false,
      code: 'RATE_LIMITED',
      retryAfterSeconds: HOUR_SECONDS,
    })
  })

  it('never reports a retry of less than a second', () => {
    const freesAt = new Date(NOW.getTime() + 10)

    expect(
      decideQuota(usageWith({ hourlyCount: 2, hourlySlotFreesAt: freesAt }), NOW),
    ).toMatchObject({ retryAfterSeconds: 1 })
  })

  it('allows the call at n - 1 of the daily quota', () => {
    expect(decideQuota(usageWith({ dailyCount: 99 }), NOW)).toEqual({ allowed: true })
  })

  it('denies the call at n with QUOTA_EXCEEDED, retryable at the next UTC midnight', () => {
    expect(decideQuota(usageWith({ dailyCount: 100 }), NOW)).toEqual({
      allowed: false,
      code: 'QUOTA_EXCEEDED',
      retryAfterSeconds: 12 * HOUR_SECONDS,
    })
  })

  it('applies the looser cap to a user on their own key', () => {
    expect(decideQuota(usageWith({ dailyCount: 100, dailyLimit: 1000 }), NOW)).toEqual({
      allowed: true,
    })
    expect(decideQuota(usageWith({ dailyCount: 1000, dailyLimit: 1000 }), NOW)).toMatchObject({
      code: 'QUOTA_EXCEEDED',
    })
  })

  it('reports the hourly limit first when both caps are exhausted', () => {
    const both = usageWith({ hourlyCount: 2, dailyCount: 100 })

    expect(decideQuota(both, NOW)).toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('still applies the hourly limit to a user on their own key', () => {
    const ownKey = usageWith({ hourlyCount: 2, dailyLimit: 1000, dailyCount: 3 })

    expect(decideQuota(ownKey, NOW)).toMatchObject({ code: 'RATE_LIMITED' })
  })
})

describe('utcWindowDate', () => {
  it('buckets by UTC day, not by the server offset', () => {
    expect(utcWindowDate(new Date('2026-08-01T23:59:59.999Z'))).toBe('2026-08-01')
    expect(utcWindowDate(new Date('2026-08-02T00:00:00.000Z'))).toBe('2026-08-02')
  })
})
