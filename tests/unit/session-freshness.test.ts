import { describe, expect, it } from 'vitest'

import { isSessionInvalidatedByPasswordChange } from '@/lib/auth/session-freshness'

describe('isSessionInvalidatedByPasswordChange', () => {
  it('keeps the session when passwordChangedAt is null', () => {
    expect(isSessionInvalidatedByPasswordChange(null, 0)).toBe(false)
  })

  it('rejects the session when passwordChangedAt seconds are greater than iat', () => {
    const changedAt = new Date('2026-08-22T12:00:00.500Z')
    const issuedAtSeconds = Math.floor(changedAt.getTime() / 1000) - 1
    expect(isSessionInvalidatedByPasswordChange(changedAt, issuedAtSeconds)).toBe(true)
  })

  it('keeps the session when passwordChangedAt seconds equal iat', () => {
    const changedAt = new Date('2026-08-22T12:00:00.500Z')
    const issuedAtSeconds = Math.floor(changedAt.getTime() / 1000)
    expect(isSessionInvalidatedByPasswordChange(changedAt, issuedAtSeconds)).toBe(false)
  })

  it('keeps the session when passwordChangedAt seconds are less than iat', () => {
    const changedAt = new Date('2026-08-22T12:00:00.500Z')
    const issuedAtSeconds = Math.floor(changedAt.getTime() / 1000) + 1
    expect(isSessionInvalidatedByPasswordChange(changedAt, issuedAtSeconds)).toBe(false)
  })

  it('rejects the session when passwordChangedAt is set and iat is missing', () => {
    expect(
      isSessionInvalidatedByPasswordChange(new Date('2026-08-22T12:00:00.000Z'), undefined),
    ).toBe(true)
  })

  it('compares at second granularity so a 500ms remainder does not kill the new cookie', () => {
    const passwordChangedAt = new Date(1_700_000_000_500)
    expect(isSessionInvalidatedByPasswordChange(passwordChangedAt, 1_700_000_000)).toBe(false)
  })
})
