import { createHash, randomBytes } from 'node:crypto'

/**
 * The share token of grill-result §5.3: 32 random bytes, base64url, stored only as
 * `sha256(token)` in `share_links.token_hash` (§8, A.10.1.1).
 *
 * 32 bytes is 43 base64url characters with no padding, which is the acceptance floor. It is also
 * the whole secret — the token is the capability, so it must never be logged, never appear in an
 * error message, and never be returned by anything but the create response.
 */

const TOKEN_RANDOM_BYTES = 32

/** The floor the S5 acceptance criteria state, asserted at the mint rather than assumed. */
export const MIN_SHARE_TOKEN_LENGTH = 43

/** base64url has no padding and no `+`/`/`, so a token is safe in a path segment unescaped. */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/

export function hashShareToken(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext, 'utf8').digest()
}

export function mintShareToken(): { readonly plaintext: string; readonly tokenHash: Buffer } {
  const plaintext = randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')
  return { plaintext, tokenHash: hashShareToken(plaintext) }
}

/**
 * Rejects a candidate before it reaches Postgres. A token arrives from a URL path, so this keeps
 * the shape check off the database and makes every malformed value one indistinguishable 404.
 */
export function isShareTokenShaped(candidate: string): boolean {
  return candidate.length >= MIN_SHARE_TOKEN_LENGTH && SHARE_TOKEN_PATTERN.test(candidate)
}

/** The `/s/{token}` URL an owner copies. `appUrl` is `APP_URL`, with or without a trailing slash. */
export function shareLinkUrl(appUrl: string, plaintext: string): string {
  return new URL(`/s/${plaintext}`, appUrl).toString()
}
