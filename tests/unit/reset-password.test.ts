import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {},
}))

vi.mock('@/lib/audit', () => ({
  recordAuditEvent: vi.fn(),
}))

const { GENERIC_RESET_FAILURE, resetPasswordSchema } = await import('@/lib/auth/reset-password')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('reset password schema and copy', () => {
  it('exports the locked failure copy', () => {
    expect(GENERIC_RESET_FAILURE).toBe('This reset link is invalid or has expired.')
  })

  it('accepts a token plus a password of 12 to 256 characters', () => {
    const parsed = resetPasswordSchema.safeParse({
      token: 'pwr_abcdefghijklmnopqrstuvwxyz',
      password: 'correct-horse-battery',
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects a password shorter than 12 characters', () => {
    expect(
      resetPasswordSchema.safeParse({
        token: 'pwr_abcdefghijklmnopqrstuvwxyz',
        password: 'short',
      }).success,
    ).toBe(false)
  })

  it('rejects a password longer than 256 characters', () => {
    expect(
      resetPasswordSchema.safeParse({
        token: 'pwr_abcdefghijklmnopqrstuvwxyz',
        password: 'a'.repeat(257),
      }).success,
    ).toBe(false)
  })

  it('rejects a missing token', () => {
    expect(resetPasswordSchema.safeParse({ password: 'correct-horse-battery' }).success).toBe(false)
  })
})
