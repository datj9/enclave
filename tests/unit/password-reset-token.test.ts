import { describe, expect, it } from 'vitest'

import {
  PASSWORD_RESET_TOKEN_PREFIX,
  hashPasswordResetToken,
  passwordResetUrl,
  isPasswordResetTokenShaped,
  mintPasswordResetToken,
} from '@/lib/auth/password-reset-tokens'

describe('password reset token minting', () => {
  it('prefixes the plaintext so a stray string is recognisable', () => {
    const minted = mintPasswordResetToken()

    expect(minted.plaintext.startsWith(PASSWORD_RESET_TOKEN_PREFIX)).toBe(true)
  })

  it('never mints the same token twice', () => {
    const minted = Array.from({ length: 50 }, () => mintPasswordResetToken().plaintext)

    expect(new Set(minted).size).toBe(50)
  })

  it('stores a 32-byte digest, not the plaintext', () => {
    const minted = mintPasswordResetToken()

    expect(minted.tokenHash).toHaveLength(32)
    expect(minted.tokenHash.toString('utf8')).not.toContain(minted.plaintext)
  })

  it('hashes deterministically so a lookup by digest finds the row', () => {
    const minted = mintPasswordResetToken()

    expect(hashPasswordResetToken(minted.plaintext).equals(minted.tokenHash)).toBe(true)
  })

  it('gives a different digest for a one-character change', () => {
    const first = hashPasswordResetToken(`${PASSWORD_RESET_TOKEN_PREFIX}abcdefghijklmnop`)
    const second = hashPasswordResetToken(`${PASSWORD_RESET_TOKEN_PREFIX}abcdefghijklmnoq`)

    expect(first.equals(second)).toBe(false)
  })
})

describe('password reset token shape check', () => {
  it('accepts a freshly minted token', () => {
    expect(isPasswordResetTokenShaped(mintPasswordResetToken().plaintext)).toBe(true)
  })

  it.each([
    ['', 'empty'],
    ['inv_abcdefghijklmnop', 'an invite prefix'],
    [PASSWORD_RESET_TOKEN_PREFIX, 'the prefix alone'],
    [`${PASSWORD_RESET_TOKEN_PREFIX}short`, 'too few random characters'],
    [`${PASSWORD_RESET_TOKEN_PREFIX}abcdefghijklmno+`, 'a character outside base64url'],
  ])('rejects %j (%s)', (candidate) => {
    expect(isPasswordResetTokenShaped(candidate)).toBe(false)
  })
})

describe('password reset url', () => {
  it('points at /reset-password with the token in the t parameter', () => {
    const url = new URL(passwordResetUrl('pwr_abcdefghijklmnop'))

    expect(url.pathname).toBe('/reset-password')
    expect(url.searchParams.get('t')).toBe('pwr_abcdefghijklmnop')
  })

  it('percent-encodes the token so a base64url value survives the round trip', () => {
    const minted = mintPasswordResetToken()

    expect(new URL(passwordResetUrl(minted.plaintext)).searchParams.get('t')).toBe(minted.plaintext)
  })
})
