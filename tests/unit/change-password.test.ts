import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({
  db: {},
}))

vi.mock('@/lib/audit', () => ({
  recordAuditEvent: vi.fn(),
}))

const { recordAuditEvent } = await import('@/lib/audit')

const {
  CURRENT_PASSWORD_INCORRECT,
  NO_PASSWORD_ACCOUNT,
  CHOOSE_DIFFERENT_PASSWORD,
  PASSWORD_TOO_SHORT,
  PASSWORD_CONFIRM_MISMATCH,
  PASSWORD_UPDATED,
  MALFORMED_CHANGE_REQUEST,
  OIDC_ONLY_PASSWORD_COPY,
  PASSWORD_CHANGE_FAILURE_REASONS,
  PASSWORD_CHANGE_FAILURES,
  PasswordChangeError,
  auditPasswordChangeFailure,
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

describe('change password failure table', () => {
  it('maps every failure to its status code, copy, and ?error= flag', () => {
    expect(PASSWORD_CHANGE_FAILURES).toStrictEqual({
      wrongCurrent: {
        code: 'UNAUTHENTICATED',
        message: CURRENT_PASSWORD_INCORRECT,
        formFlag: 'wrong_current',
        auditReason: 'wrong_current',
      },
      noPassword: {
        code: 'FORBIDDEN',
        message: NO_PASSWORD_ACCOUNT,
        formFlag: 'no_password',
        auditReason: 'no_password',
      },
      samePassword: {
        code: 'VALIDATION_FAILED',
        message: CHOOSE_DIFFERENT_PASSWORD,
        formFlag: 'same',
        auditReason: 'same_password',
      },
      confirmMismatch: {
        code: 'VALIDATION_FAILED',
        message: PASSWORD_CONFIRM_MISMATCH,
        formFlag: 'mismatch',
        auditReason: 'malformed',
      },
      passwordTooShort: {
        code: 'VALIDATION_FAILED',
        message: PASSWORD_TOO_SHORT,
        formFlag: 'password',
        auditReason: 'malformed',
      },
      malformedRequest: {
        code: 'VALIDATION_FAILED',
        message: MALFORMED_CHANGE_REQUEST,
        formFlag: 'malformed',
        auditReason: 'malformed',
      },
    })
  })

  it('audits every failure under one of the four recorded reasons', () => {
    for (const failure of Object.values(PASSWORD_CHANGE_FAILURES)) {
      expect(PASSWORD_CHANGE_FAILURE_REASONS).toContain(failure.auditReason)
    }
  })

  it('carries the code, status, copy, and flag of its failure kind', () => {
    const error = new PasswordChangeError('wrongCurrent')

    expect(error.formFlag).toBe('wrong_current')
    expect(error.code).toBe('UNAUTHENTICATED')
    expect(error.status).toBe(401)
    expect(error.message).toBe(CURRENT_PASSWORD_INCORRECT)
  })

  it('keys the form flag on the failure kind, not on the copy or the audit reason', () => {
    const mismatch = PASSWORD_CHANGE_FAILURES.confirmMismatch
    const tooShort = PASSWORD_CHANGE_FAILURES.passwordTooShort

    expect(mismatch.auditReason).toBe(tooShort.auditReason)
    expect(mismatch.code).toBe(tooShort.code)
    expect(mismatch.formFlag).not.toBe(tooShort.formFlag)
  })
})

describe('auditPasswordChangeFailure', () => {
  it('resolves the error only after the audit write has completed', async () => {
    let hasAuditCompleted = false
    vi.mocked(recordAuditEvent).mockImplementationOnce(async () => {
      await Promise.resolve()
      hasAuditCompleted = true
    })

    const error = await auditPasswordChangeFailure('wrongCurrent', 'user-id', '198.51.100.7')

    expect(hasAuditCompleted).toBe(true)
    expect(error).toBeInstanceOf(PasswordChangeError)
    expect(error.formFlag).toBe('wrong_current')
  })

  it('records the table reason and never the password', async () => {
    await auditPasswordChangeFailure('passwordTooShort', 'user-id', null)

    expect(recordAuditEvent).toHaveBeenCalledWith({
      action: 'auth.password_change_failed',
      actorUserId: 'user-id',
      actorIp: null,
      metadata: { reason: 'malformed' },
    })
  })
})
