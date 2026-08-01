import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '@/lib/auth/password'

interface FakeUserRow {
  readonly id: string
  readonly passwordHash: string | null
  readonly isActive: boolean
}

const selectedRows: FakeUserRow[] = []

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

const { authenticateWithPassword, credentialsSchema, GENERIC_SIGNIN_FAILURE } =
  await import('@/lib/auth/credentials')

const CORRECT_PASSWORD = 'correct-horse-battery'

function stubUser(row: FakeUserRow | null): void {
  selectedRows.length = 0
  if (row !== null) selectedRows.push(row)
}

beforeEach(() => {
  stubUser(null)
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

  it('reveals nothing about which check failed', () => {
    expect(GENERIC_SIGNIN_FAILURE).toBe('Email or password is incorrect')
  })
})
