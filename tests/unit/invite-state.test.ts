import { describe, expect, it } from 'vitest'

import { HttpError } from '@/lib/http'
import {
  INVITE_ALREADY_USED,
  INVITE_EXPIRED,
  INVITE_NOT_FOUND,
  INVITE_REVOKED,
  assertInviteAcceptsEmail,
  assertRedeemable,
} from '@/lib/invites/redeem'
import {
  OPEN_REGISTRATION_WARNING,
  openRegistrationWarning,
  registrationModeLabel,
} from '@/lib/admin/registration-notice'

const INVITE_ID = '9c858901-8a57-4791-81fe-4c455b099bc9'

function stateOf(overrides: {
  readonly usedAt?: Date | null
  readonly revokedAt?: Date | null
  readonly isExpired?: boolean
  readonly email?: string | null
}) {
  return {
    id: INVITE_ID,
    email: overrides.email ?? null,
    usedAt: overrides.usedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    isExpired: overrides.isExpired ?? false,
  }
}

function caught(run: () => void): HttpError {
  try {
    run()
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected an HttpError')
}

describe('invite redeemability', () => {
  it('accepts an unused, unrevoked, unexpired invite', () => {
    expect(assertRedeemable(stateOf({ email: 'dave@example.com' }))).toEqual({
      id: INVITE_ID,
      email: 'dave@example.com',
    })
  })

  it('404s an unknown token rather than confirming the id space', () => {
    const error = caught(() => assertRedeemable(undefined))

    expect([error.status, error.code, error.message]).toEqual([404, 'NOT_FOUND', INVITE_NOT_FOUND])
  })

  it('410s a second redemption', () => {
    const error = caught(() => assertRedeemable(stateOf({ usedAt: new Date() })))

    expect([error.status, error.code, error.message]).toEqual([
      410,
      'VALIDATION_FAILED',
      INVITE_ALREADY_USED,
    ])
  })

  it('410s an expired invite', () => {
    const error = caught(() => assertRedeemable(stateOf({ isExpired: true })))

    expect([error.status, error.message]).toEqual([410, INVITE_EXPIRED])
  })

  it('410s a revoked invite', () => {
    const error = caught(() => assertRedeemable(stateOf({ revokedAt: new Date() })))

    expect([error.status, error.message]).toEqual([410, INVITE_REVOKED])
  })

  it('reports "used" ahead of "revoked" — the redemption is what actually happened', () => {
    const error = caught(() =>
      assertRedeemable(stateOf({ usedAt: new Date(), revokedAt: new Date() })),
    )

    expect(error.message).toBe(INVITE_ALREADY_USED)
  })
})

describe('invite email binding', () => {
  it('accepts the address the invite names', () => {
    expect(() =>
      assertInviteAcceptsEmail({ id: INVITE_ID, email: 'dave@example.com' }, 'dave@example.com'),
    ).not.toThrow()
  })

  it('accepts it case-insensitively, matching the citext column', () => {
    expect(() =>
      assertInviteAcceptsEmail({ id: INVITE_ID, email: 'Dave@Example.com' }, 'dave@example.com'),
    ).not.toThrow()
  })

  it('refuses a different address, so a named invite is not transferable', () => {
    const error = caught(() =>
      assertInviteAcceptsEmail({ id: INVITE_ID, email: 'dave@example.com' }, 'eve@example.com'),
    )

    expect([error.status, error.code]).toEqual([422, 'VALIDATION_FAILED'])
  })

  it('accepts any address on a link-only invite', () => {
    expect(() =>
      assertInviteAcceptsEmail({ id: INVITE_ID, email: null }, 'anyone@example.com'),
    ).not.toThrow()
  })
})

describe('open registration warning (decision #25)', () => {
  it('warns that org-visible means anyone who signs up while the flag is on', () => {
    const warning = openRegistrationWarning(true)

    expect(warning).toBe(OPEN_REGISTRATION_WARNING)
    expect(warning).toContain('anyone who signs up')
    expect(warning).toContain('Organization')
  })

  it('says nothing on an invite-only instance', () => {
    expect(openRegistrationWarning(false)).toBeNull()
  })

  it('labels the two registration modes', () => {
    expect([registrationModeLabel(true), registrationModeLabel(false)]).toEqual([
      'open',
      'invite-only',
    ])
  })
})
