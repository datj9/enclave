import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {},
}))

vi.mock('@/lib/audit', () => ({
  recordAuditEvent: vi.fn(),
}))

const {
  CURRENT_PASSWORD_INCORRECT,
  NO_PASSWORD_ACCOUNT,
  CHOOSE_DIFFERENT_PASSWORD,
  PASSWORD_TOO_SHORT,
  PASSWORD_CONFIRM_MISMATCH,
  PASSWORD_UPDATED,
  OIDC_ONLY_PASSWORD_COPY,
  changePasswordSchema,
} = await import('@/lib/auth/change-password')

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('change password copy and schema', () => {
  it('exports the locked JSON and page copy', () => {
    expect(CURRENT_PASSWORD_INCORRECT).toBe('Current password is incorrect')
    expect(NO_PASSWORD_ACCOUNT).toBe('This account has no password')
    expect(CHOOSE_DIFFERENT_PASSWORD).toBe('Choose a different password')
    expect(PASSWORD_TOO_SHORT).toBe('Enter a password of at least 12 characters')
    expect(PASSWORD_CONFIRM_MISMATCH).toBe('New password and confirmation do not match')
    expect(PASSWORD_UPDATED).toBe('Password updated.')
    expect(OIDC_ONLY_PASSWORD_COPY).toBe(
      'This account signs in with your identity provider and has no password.',
    )
  })

  it('accepts current, new, and matching confirm of 12 to 256 characters', () => {
    const parsed = changePasswordSchema.safeParse({
      currentPassword: 'correct-horse-battery',
      newPassword: 'new-correct-horse',
      confirmNewPassword: 'new-correct-horse',
    })

    expect(parsed.success).toBe(true)
  })

  it('rejects a new password shorter than 12 characters', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'correct-horse-battery',
        newPassword: 'short',
        confirmNewPassword: 'short',
      }).success,
    ).toBe(false)
  })

  it('rejects a new password longer than 256 characters', () => {
    expect(
      changePasswordSchema.safeParse({
        currentPassword: 'correct-horse-battery',
        newPassword: 'a'.repeat(257),
        confirmNewPassword: 'a'.repeat(257),
      }).success,
    ).toBe(false)
  })

  it('rejects a confirm that does not match newPassword', () => {
    const parsed = changePasswordSchema.safeParse({
      currentPassword: 'correct-horse-battery',
      newPassword: 'new-correct-horse',
      confirmNewPassword: 'other-correct-horse',
    })

    expect(parsed.success).toBe(false)
  })

  it('rejects a missing currentPassword', () => {
    expect(
      changePasswordSchema.safeParse({
        newPassword: 'new-correct-horse',
        confirmNewPassword: 'new-correct-horse',
      }).success,
    ).toBe(false)
  })

  it('does not treat new === current as a schema error', () => {
    const parsed = changePasswordSchema.safeParse({
      currentPassword: 'correct-horse-battery',
      newPassword: 'correct-horse-battery',
      confirmNewPassword: 'correct-horse-battery',
    })

    expect(parsed.success).toBe(true)
  })
})
