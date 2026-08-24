import { createHash, randomBytes } from 'node:crypto'

import { env } from '@/env'

/**
 * Password reset token minting and hashing, mirroring `src/lib/invites/tokens.ts` exactly:
 * 32 random bytes behind a recognisable prefix, persisted only as a SHA-256 digest, plaintext
 * sent once in the reset mail.
 *
 * Never log a token value and never put one in an error message (§8 log hygiene).
 */

export const PASSWORD_RESET_TOKEN_PREFIX = 'pwr_'

const TOKEN_RANDOM_BYTES = 32

export const RESET_PASSWORD_PATH = '/reset-password'
export const PASSWORD_RESET_TOKEN_PARAMETER = 't'

export interface MintedPasswordResetToken {
  readonly plaintext: string
  readonly tokenHash: Buffer
}

export function hashPasswordResetToken(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext, 'utf8').digest()
}

export function mintPasswordResetToken(): MintedPasswordResetToken {
  const plaintext = `${PASSWORD_RESET_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString(
    'base64url',
  )}`
  return { plaintext, tokenHash: hashPasswordResetToken(plaintext) }
}

/**
 * Cheap shape check so a random string never reaches a Postgres lookup. It proves nothing about
 * validity — only the consume step does that.
 */
export function isPasswordResetTokenShaped(candidate: string): boolean {
  if (!candidate.startsWith(PASSWORD_RESET_TOKEN_PREFIX)) return false
  return /^[A-Za-z0-9_-]{16,}$/.test(candidate.slice(PASSWORD_RESET_TOKEN_PREFIX.length))
}

/** The capability URL put in the reset mail. */
export function passwordResetUrl(plaintext: string): string {
  const url = new URL(RESET_PASSWORD_PATH, env.APP_URL)
  url.searchParams.set(PASSWORD_RESET_TOKEN_PARAMETER, plaintext)
  return url.toString()
}
