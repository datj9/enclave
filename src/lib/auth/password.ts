import { hash, verify, type Algorithm } from '@node-rs/argon2'

// @node-rs/argon2 declares Algorithm as an *ambient* const enum, which isolatedModules
// (required by Next.js) forbids reading. The numeric value is stable and part of its API.
const ARGON2ID = 2 as Algorithm

/**
 * argon2id at the parameters locked in grill-result §8 (A.9.4.2). These are part of the
 * stored hash string, so changing them here does not invalidate existing hashes — argon2
 * reads each hash's own parameters when verifying.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

/** Rejected before hashing so a 1-character password can never reach the database. */
export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 256

export async function hashPassword(plaintextPassword: string): Promise<string> {
  return hash(plaintextPassword, ARGON2_OPTIONS)
}

/**
 * Returns false rather than throwing on a malformed or absent hash: an OIDC-only user has
 * `password_hash = NULL`, and that is a failed password sign-in, not an error.
 */
export async function verifyPassword(
  storedHash: string | null,
  plaintextPassword: string,
): Promise<boolean> {
  if (storedHash === null || storedHash === '') return false
  try {
    // No options: argon2 reads the parameters embedded in the hash string itself.
    return await verify(storedHash, plaintextPassword)
  } catch {
    return false
  }
}
