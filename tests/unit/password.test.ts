import { hash } from '@node-rs/argon2'
import { describe, expect, it } from 'vitest'
import { ARGON2_OPTIONS, hashPassword, verifyPassword } from '@/lib/auth/password'

const CORRECT_PASSWORD = 'correct-horse-battery'

describe('hashPassword', () => {
  it('produces an argon2id hash carrying the locked parameters', async () => {
    const storedHash = await hashPassword(CORRECT_PASSWORD)

    expect(storedHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
  })

  it('pins the parameters from grill-result §8', () => {
    expect(ARGON2_OPTIONS.memoryCost).toBe(19_456)
    expect(ARGON2_OPTIONS.timeCost).toBe(2)
    expect(ARGON2_OPTIONS.parallelism).toBe(1)
  })

  it('never stores the plaintext', async () => {
    const storedHash = await hashPassword(CORRECT_PASSWORD)

    expect(storedHash).not.toContain(CORRECT_PASSWORD)
  })

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([
      hashPassword(CORRECT_PASSWORD),
      hashPassword(CORRECT_PASSWORD),
    ])

    expect(first).not.toBe(second)
  })
})

describe('verifyPassword', () => {
  it('accepts the correct password', async () => {
    const storedHash = await hashPassword(CORRECT_PASSWORD)

    await expect(verifyPassword(storedHash, CORRECT_PASSWORD)).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const storedHash = await hashPassword(CORRECT_PASSWORD)

    await expect(verifyPassword(storedHash, 'wrong-horse-battery')).resolves.toBe(false)
  })

  it('rejects a password differing only in case', async () => {
    const storedHash = await hashPassword(CORRECT_PASSWORD)

    await expect(verifyPassword(storedHash, CORRECT_PASSWORD.toUpperCase())).resolves.toBe(false)
  })

  it('returns false for a null hash, as held by an OIDC-only user', async () => {
    await expect(verifyPassword(null, CORRECT_PASSWORD)).resolves.toBe(false)
  })

  it('returns false for an empty hash', async () => {
    await expect(verifyPassword('', CORRECT_PASSWORD)).resolves.toBe(false)
  })

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword('not-an-argon2-hash', CORRECT_PASSWORD)).resolves.toBe(false)
  })

  it('verifies a hash produced with weaker parameters', async () => {
    // A hash carries its own parameters, so raising the cost later must not lock users out.
    const legacyHash = await hash(CORRECT_PASSWORD, {
      ...ARGON2_OPTIONS,
      memoryCost: 4096,
      timeCost: 3,
    })

    expect(legacyHash).toContain('m=4096,t=3,p=1')
    await expect(verifyPassword(legacyHash, CORRECT_PASSWORD)).resolves.toBe(true)
  })
})
