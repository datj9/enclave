import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as passwordModule from '@/lib/auth/password'
import { ARGON2_OPTIONS, hashPassword } from '@/lib/auth/password'

interface FakeUserRow {
  readonly id: string
  readonly passwordHash: string | null
  readonly isActive: boolean
}

const selectedRows: FakeUserRow[] = []

/** Records every hash argon2 is asked to verify, so the timing-uniformity claim is testable. */
const { verifiedHashes } = vi.hoisted(() => ({ verifiedHashes: [] as (string | null)[] }))

vi.mock('@/lib/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof passwordModule>()
  return {
    ...actual,
    verifyPassword: async (storedHash: string | null, plaintext: string) => {
      verifiedHashes.push(storedHash)
      return actual.verifyPassword(storedHash, plaintext)
    },
  }
})

/** Stands in for the whole query builder chain so the auth decision can be tested alone. */
vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectedRows),
        }),
      }),
    }),
  },
}))

const { authenticateWithPassword, credentialsSchema, DUMMY_PASSWORD_HASH, GENERIC_SIGNIN_FAILURE } =
  await import('@/lib/auth/credentials')

const CORRECT_PASSWORD = 'correct-horse-battery'

function stubUser(row: FakeUserRow | null): void {
  selectedRows.length = 0
  if (row !== null) selectedRows.push(row)
}

beforeEach(() => {
  stubUser(null)
  verifiedHashes.length = 0
})

describe('credentialsSchema', () => {
  it('accepts a valid email and password', () => {
    const parsed = credentialsSchema.safeParse({
      email: 'ops@example.com',
      password: CORRECT_PASSWORD,
    })

    expect(parsed.success).toBe(true)
  })

  it('lowercases and trims the email so sign-in is case-insensitive', () => {
    const parsed = credentialsSchema.parse({
      email: '  OPS@Example.COM  ',
      password: CORRECT_PASSWORD,
    })

    expect(parsed.email).toBe('ops@example.com')
  })

  it('rejects a malformed email', () => {
    expect(
      credentialsSchema.safeParse({ email: 'not-an-email', password: CORRECT_PASSWORD }).success,
    ).toBe(false)
  })

  it('rejects a password shorter than 12 characters', () => {
    expect(
      credentialsSchema.safeParse({ email: 'ops@example.com', password: 'short' }).success,
    ).toBe(false)
  })

  it('rejects an absurdly long password rather than hashing it', () => {
    const parsed = credentialsSchema.safeParse({
      email: 'ops@example.com',
      password: 'a'.repeat(257),
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects a missing password', () => {
    expect(credentialsSchema.safeParse({ email: 'ops@example.com' }).success).toBe(false)
  })
})

describe('authenticateWithPassword', () => {
  it('succeeds for an active user with the correct password', async () => {
    stubUser({ id: 'user-1', passwordHash: await hashPassword(CORRECT_PASSWORD), isActive: true })

    await expect(
      authenticateWithPassword({ email: 'ops@example.com', password: CORRECT_PASSWORD }),
    ).resolves.toEqual({ ok: true, userId: 'user-1' })
  })

  it('fails for an unknown email', async () => {
    stubUser(null)

    await expect(
      authenticateWithPassword({ email: 'nobody@example.com', password: CORRECT_PASSWORD }),
    ).resolves.toEqual({ ok: false })
  })

  it('fails for a wrong password', async () => {
    stubUser({ id: 'user-1', passwordHash: await hashPassword(CORRECT_PASSWORD), isActive: true })

    await expect(
      authenticateWithPassword({ email: 'ops@example.com', password: 'wrong-horse-battery' }),
    ).resolves.toEqual({ ok: false })
  })

  it('fails for a deactivated user holding the correct password', async () => {
    stubUser({ id: 'user-1', passwordHash: await hashPassword(CORRECT_PASSWORD), isActive: false })

    await expect(
      authenticateWithPassword({ email: 'ops@example.com', password: CORRECT_PASSWORD }),
    ).resolves.toEqual({ ok: false })
  })

  it('fails for an OIDC-only user with no password hash', async () => {
    stubUser({ id: 'user-1', passwordHash: null, isActive: true })

    await expect(
      authenticateWithPassword({ email: 'ops@example.com', password: CORRECT_PASSWORD }),
    ).resolves.toEqual({ ok: false })
  })

  it('still pays for one argon2 verification when the email is unknown', async () => {
    stubUser(null)

    await authenticateWithPassword({ email: 'nobody@example.com', password: CORRECT_PASSWORD })

    expect(verifiedHashes).toHaveLength(1)
    expect(verifiedHashes[0]).toMatch(/^\$argon2id\$/)
  })

  it('verifies an OIDC-only account against the dummy hash, not a null', async () => {
    stubUser({ id: 'user-1', passwordHash: null, isActive: true })

    await authenticateWithPassword({ email: 'ops@example.com', password: CORRECT_PASSWORD })

    expect(verifiedHashes).toHaveLength(1)
    expect(verifiedHashes[0]).toMatch(/^\$argon2id\$/)
  })

  it('reuses one dummy hash across calls rather than hashing per request', async () => {
    await authenticateWithPassword({ email: 'a@example.com', password: CORRECT_PASSWORD })
    await authenticateWithPassword({ email: 'b@example.com', password: CORRECT_PASSWORD })

    expect(verifiedHashes).toHaveLength(2)
    expect(verifiedHashes[0]).toBe(verifiedHashes[1])
  })

  it('keeps the dummy hash at the same argon2 parameters as real hashes', () => {
    const { memoryCost, timeCost, parallelism } = ARGON2_OPTIONS
    expect(DUMMY_PASSWORD_HASH).toMatch(
      new RegExp(`^\\$argon2id\\$v=19\\$m=${memoryCost},t=${timeCost},p=${parallelism}\\$`),
    )
  })

  it('verifies a deactivated account against its own hash exactly once', async () => {
    const storedHash = await hashPassword(CORRECT_PASSWORD)
    stubUser({ id: 'user-1', passwordHash: storedHash, isActive: false })

    await authenticateWithPassword({ email: 'ops@example.com', password: CORRECT_PASSWORD })

    expect(verifiedHashes).toEqual([storedHash])
  })

  it('reveals nothing about which check failed', () => {
    expect(GENERIC_SIGNIN_FAILURE).toBe('Email or password is incorrect')
  })
})
