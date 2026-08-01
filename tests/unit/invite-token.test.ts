import { describe, expect, it } from 'vitest'

import {
  INVITE_TOKEN_PREFIX,
  hashInviteToken,
  inviteUrl,
  isInviteTokenShaped,
  mintInviteToken,
} from '@/lib/invites/tokens'

describe('invite token minting', () => {
  it('prefixes the plaintext so a stray string is recognisable', () => {
    const minted = mintInviteToken()

    expect(minted.plaintext.startsWith(INVITE_TOKEN_PREFIX)).toBe(true)
  })

  it('never mints the same token twice', () => {
    const minted = Array.from({ length: 50 }, () => mintInviteToken().plaintext)

    expect(new Set(minted).size).toBe(50)
  })

  it('stores a 32-byte digest, not the plaintext', () => {
    const minted = mintInviteToken()

    expect(minted.tokenHash).toHaveLength(32)
    expect(minted.tokenHash.toString('utf8')).not.toContain(minted.plaintext)
  })

  it('hashes deterministically so a lookup by digest finds the row', () => {
    const minted = mintInviteToken()

    expect(hashInviteToken(minted.plaintext).equals(minted.tokenHash)).toBe(true)
  })

  it('gives a different digest for a one-character change', () => {
    const first = hashInviteToken(`${INVITE_TOKEN_PREFIX}abcdefghijklmnop`)
    const second = hashInviteToken(`${INVITE_TOKEN_PREFIX}abcdefghijklmnoq`)

    expect(first.equals(second)).toBe(false)
  })
})

describe('invite token shape check', () => {
  it('accepts a freshly minted token', () => {
    expect(isInviteTokenShaped(mintInviteToken().plaintext)).toBe(true)
  })

  it.each([
    ['', 'empty'],
    ['enc_abcdefghijklmnop', 'an API token prefix'],
    [INVITE_TOKEN_PREFIX, 'the prefix alone'],
    [`${INVITE_TOKEN_PREFIX}short`, 'too few random characters'],
    [`${INVITE_TOKEN_PREFIX}abcdefghijklmno+`, 'a character outside base64url'],
  ])('rejects %j (%s)', (candidate) => {
    expect(isInviteTokenShaped(candidate)).toBe(false)
  })
})

describe('invite url', () => {
  it('points at /signup with the token in the t parameter', () => {
    const url = new URL(inviteUrl('inv_abcdefghijklmnop'))

    expect(url.pathname).toBe('/signup')
    expect(url.searchParams.get('t')).toBe('inv_abcdefghijklmnop')
  })

  it('percent-encodes the token so a base64url value survives the round trip', () => {
    const minted = mintInviteToken()

    expect(new URL(inviteUrl(minted.plaintext)).searchParams.get('t')).toBe(minted.plaintext)
  })
})
