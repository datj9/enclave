import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  hashShareToken,
  isShareTokenShaped,
  MIN_SHARE_TOKEN_LENGTH,
  mintShareToken,
  shareLinkUrl,
} from '@/lib/shares/token'

/**
 * The secret half of S5: the token is the capability, so its length, alphabet, and the fact that
 * only a digest of it is ever storable are all acceptance criteria rather than implementation
 * details (§8, A.10.1.1).
 */

const APP_URL = 'https://app.example.com'

describe('mintShareToken', () => {
  it('produces at least 43 base64url characters, the 32-random-byte floor', () => {
    const { plaintext } = mintShareToken()

    expect(plaintext.length).toBeGreaterThanOrEqual(MIN_SHARE_TOKEN_LENGTH)
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('never repeats a token across a batch', () => {
    const minted = Array.from({ length: 500 }, () => mintShareToken().plaintext)

    expect(new Set(minted).size).toBe(minted.length)
  })

  it('returns a hash that is the SHA-256 of the plaintext and nothing else', () => {
    const { plaintext, tokenHash } = mintShareToken()

    expect(tokenHash).toEqual(createHash('sha256').update(plaintext, 'utf8').digest())
    expect(tokenHash).toHaveLength(32)
  })

  it('produces a hash that does not contain the plaintext in any encoding', () => {
    const { plaintext, tokenHash } = mintShareToken()

    expect(tokenHash.toString('base64url')).not.toContain(plaintext)
    expect(tokenHash.toString('utf8')).not.toContain(plaintext)
  })
})

describe('hashShareToken', () => {
  it('is stable, so the same token always finds the same row', () => {
    expect(hashShareToken('same-token')).toEqual(hashShareToken('same-token'))
  })

  it('differs for a token that differs by one character', () => {
    expect(hashShareToken('token-a')).not.toEqual(hashShareToken('token-b'))
  })
})

describe('isShareTokenShaped', () => {
  it('accepts a freshly minted token', () => {
    expect(isShareTokenShaped(mintShareToken().plaintext)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['too short', 'a'.repeat(MIN_SHARE_TOKEN_LENGTH - 1)],
    ['standard base64 padding', `${'a'.repeat(MIN_SHARE_TOKEN_LENGTH)}==`],
    ['a slash from standard base64', `${'a'.repeat(MIN_SHARE_TOKEN_LENGTH)}/x`],
    ['a path traversal attempt', `../${'a'.repeat(MIN_SHARE_TOKEN_LENGTH)}`],
    ['a SQL fragment', `${"' or 1=1--".padEnd(MIN_SHARE_TOKEN_LENGTH, 'a')}`],
  ])('refuses %s before it reaches Postgres', (_name, candidate) => {
    expect(isShareTokenShaped(candidate)).toBe(false)
  })
})

describe('shareLinkUrl', () => {
  it('puts the token in the /s/ path of the app origin', () => {
    expect(shareLinkUrl(APP_URL, 'Yk3nQ')).toBe('https://app.example.com/s/Yk3nQ')
  })

  it('does not double the slash when APP_URL already ends in one', () => {
    expect(shareLinkUrl('https://app.example.com/', 'Yk3nQ')).toBe('https://app.example.com/s/Yk3nQ')
  })
})
