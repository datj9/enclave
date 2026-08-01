import { createHash, randomBytes } from 'node:crypto'

import { env } from '@/env'

/**
 * Invite token minting and hashing, mirroring `src/lib/auth/bearer.ts` exactly: 32 random bytes
 * behind a recognisable prefix, persisted only as a SHA-256 digest, plaintext returned once.
 *
 * Never log a token value and never put one in an error message (§8 log hygiene).
 */

export const INVITE_TOKEN_PREFIX = 'inv_'

const TOKEN_RANDOM_BYTES = 32

export const SIGNUP_PATH = '/signup'
export const INVITE_TOKEN_PARAMETER = 't'

export interface MintedInviteToken {
  readonly plaintext: string
  readonly tokenHash: Buffer
}

export function hashInviteToken(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext, 'utf8').digest()
}

export function mintInviteToken(): MintedInviteToken {
  const plaintext = `${INVITE_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`
  return { plaintext, tokenHash: hashInviteToken(plaintext) }
}

/**
 * Cheap shape check so a random string never reaches a Postgres lookup. It proves nothing about
 * validity — only `findInviteByToken` does that.
 */
export function isInviteTokenShaped(candidate: string): boolean {
  if (!candidate.startsWith(INVITE_TOKEN_PREFIX)) return false
  return /^[A-Za-z0-9_-]{16,}$/.test(candidate.slice(INVITE_TOKEN_PREFIX.length))
}

/** The URL the admin copies. There is no email delivery in v1 (S10 out of scope). */
export function inviteUrl(plaintext: string): string {
  const url = new URL(SIGNUP_PATH, env.APP_URL)
  url.searchParams.set(INVITE_TOKEN_PARAMETER, plaintext)
  return url.toString()
}
