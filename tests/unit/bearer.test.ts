import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  apiTokenViewerRef,
  userIdFromViewerRef,
  userViewerRef,
  viewerUserIdFromRef,
} from '@/lib/artifacts/authorize'
import {
  API_TOKEN_PREFIX,
  bearerTokenFromHeaders,
  hashApiToken,
  isPlaintextTransport,
  mintApiToken,
} from '@/lib/auth/bearer'

/**
 * The half of S8 that needs neither Postgres nor a request scope. Scope enforcement against real
 * tokens and endpoints is tests/integration/api-tokens.test.ts.
 */

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** 32 random bytes in base64url, unpadded. */
const TOKEN_PATTERN = /^enc_[A-Za-z0-9_-]{43}$/

function headers(record: Record<string, string>): Headers {
  return new Headers(record)
}

describe('mintApiToken', () => {
  it('produces enc_ plus 32 random bytes base64url', () => {
    expect(mintApiToken().plaintext).toMatch(TOKEN_PATTERN)
  })

  it('never repeats a value across mints', () => {
    const minted = Array.from({ length: 200 }, () => mintApiToken().plaintext)

    expect(new Set(minted).size).toBe(minted.length)
  })

  it('returns the sha256 of the plaintext, so only the digest can be stored', () => {
    const { plaintext, tokenHash } = mintApiToken()

    expect(tokenHash).toEqual(createHash('sha256').update(plaintext, 'utf8').digest())
    expect(tokenHash).toHaveLength(32)
  })

  it('does not leak the plaintext into the hash', () => {
    const { plaintext, tokenHash } = mintApiToken()

    expect(tokenHash.toString('binary')).not.toContain(plaintext)
  })
})

describe('hashApiToken', () => {
  it('is deterministic for the same token', () => {
    const token = `${API_TOKEN_PREFIX}fixed-value-for-the-test`

    expect(hashApiToken(token)).toEqual(hashApiToken(token))
  })

  it('differs for a one-character change', () => {
    expect(hashApiToken('enc_aaa')).not.toEqual(hashApiToken('enc_aab'))
  })
})

describe('bearerTokenFromHeaders', () => {
  it('reads the credential after the scheme', () => {
    expect(bearerTokenFromHeaders(headers({ authorization: 'Bearer enc_abc' }))).toBe('enc_abc')
  })

  it.each([
    ['a lowercase scheme', 'bearer enc_abc'],
    ['an uppercase scheme', 'BEARER enc_abc'],
    ['padding around the credential', 'Bearer    enc_abc  '],
  ])('accepts %s', (_case, value) => {
    expect(bearerTokenFromHeaders(headers({ authorization: value }))).toBe('enc_abc')
  })

  it.each([
    ['no header at all', {}],
    ['an empty header', { authorization: '' }],
    ['a scheme with no credential', { authorization: 'Bearer' }],
    ['a blank credential', { authorization: 'Bearer   ' }],
    ['basic authentication', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['a bare token with no scheme', { authorization: 'enc_abc' }],
  ])('returns null for %s', (_case, record) => {
    expect(bearerTokenFromHeaders(headers(record))).toBeNull()
  })
})

describe('the apiToken viewer kind', () => {
  it('resolves to the owning user, so a token reads exactly what its owner reads', () => {
    expect(viewerUserIdFromRef(apiTokenViewerRef(USER_ID))).toBe(USER_ID)
    expect(viewerUserIdFromRef(userViewerRef(USER_ID))).toBe(USER_ID)
  })

  it('is a distinct ref from a session viewer of the same user', () => {
    expect(apiTokenViewerRef(USER_ID)).not.toBe(userViewerRef(USER_ID))
  })

  it('is not accepted by the session-only resolver the handoff flow uses', () => {
    expect(userIdFromViewerRef(apiTokenViewerRef(USER_ID))).toBeNull()
  })

  it.each([
    ['a non-uuid user', 'apiToken:not-a-uuid'],
    ['an empty user', 'apiToken:'],
    ['an unknown kind', 'robot:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ['a bare id', USER_ID],
  ])('rejects %s', (_case, viewerRef) => {
    expect(viewerUserIdFromRef(viewerRef)).toBeNull()
  })
})

describe('isPlaintextTransport', () => {
  function requestWith(url: string, record: Record<string, string> = {}): Request {
    return new Request(url, { headers: record })
  }

  it.each([
    ['a proxy that terminated TLS', 'http://app.example.com/x', { 'x-forwarded-proto': 'https' }],
    ['the first hop of a proxy chain', 'http://app.example.com/x', {
      'x-forwarded-proto': 'https, http',
    }],
    ['a direct https connection', 'https://app.example.com/x', {}],
    ['a loopback hostname', 'http://localhost:3000/x', {}],
    ['a loopback address', 'http://127.0.0.1:3000/x', {}],
    ['an ipv6 loopback address', 'http://[::1]:3000/x', {}],
  ])('accepts %s', (_case, url, record) => {
    expect(isPlaintextTransport(requestWith(url, record))).toBe(false)
  })

  it.each([
    ['a plaintext hop behind a proxy', 'https://app.example.com/x', {
      'x-forwarded-proto': 'http',
    }],
    ['a direct http connection', 'http://app.example.com/x', {}],
    ['a hostname that merely starts with localhost', 'http://localhost.example.com/x', {}],
  ])('rejects %s', (_case, url, record) => {
    expect(isPlaintextTransport(requestWith(url, record))).toBe(true)
  })
})
