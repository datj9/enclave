import { and, eq, isNull, sql as raw } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError, type ErrorCode } from '@/lib/http'
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from './password'
import { PASSWORD_RESET_LOCK_NAMESPACE } from './forgot-password'

export const CURRENT_PASSWORD_INCORRECT = 'Current password is incorrect'
export const NO_PASSWORD_ACCOUNT = 'This account has no password'
export const CHOOSE_DIFFERENT_PASSWORD = 'Choose a different password'
export const PASSWORD_TOO_SHORT = 'Enter a password of at least 12 characters'
export const PASSWORD_CONFIRM_MISMATCH = 'New password and confirmation do not match'
export const PASSWORD_UPDATED = 'Password updated.'
export const MALFORMED_CHANGE_REQUEST =
  'Enter your current password and a new password of at least 12 characters'
export const OIDC_ONLY_PASSWORD_COPY =
  'This account signs in with your identity provider and has no password.'

export const PASSWORD_CHANGE_FAILURE_REASONS = [
  'wrong_current',
  'no_password',
  'malformed',
  'same_password',
] as const
export type PasswordChangeFailureReason = (typeof PASSWORD_CHANGE_FAILURE_REASONS)[number]

export type PasswordChangeFormFlag =
  'wrong_current' | 'mismatch' | 'password' | 'same' | 'no_password' | 'malformed'

interface PasswordChangeFailure {
  readonly code: ErrorCode
  readonly message: string
  readonly formFlag: PasswordChangeFormFlag
  readonly auditReason: PasswordChangeFailureReason
}

/** The one mapping per failure; `formFlag` is the `?error=` value app/settings/password renders. */
export const PASSWORD_CHANGE_FAILURES = {
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
} as const satisfies Readonly<Record<string, PasswordChangeFailure>>

export type PasswordChangeFailureKind = keyof typeof PASSWORD_CHANGE_FAILURES

export class PasswordChangeError extends HttpError {
  readonly failureKind: PasswordChangeFailureKind

  constructor(failureKind: PasswordChangeFailureKind) {
    const failure = PASSWORD_CHANGE_FAILURES[failureKind]
    super(failure.code, failure.message)
    this.name = 'PasswordChangeError'
    this.failureKind = failureKind
  }

  get formFlag(): PasswordChangeFormFlag {
    return PASSWORD_CHANGE_FAILURES[this.failureKind].formFlag
  }
}

/** Awaits the audit row before the caller throws, so a torn-down request cannot drop it. */
export async function auditPasswordChangeFailure(
  failureKind: PasswordChangeFailureKind,
  userId: string,
  actorIp: string | null,
): Promise<PasswordChangeError> {
  await recordAuditEvent({
    action: 'auth.password_change_failed',
    actorUserId: userId,
    actorIp,
    metadata: { reason: PASSWORD_CHANGE_FAILURES[failureKind].auditReason },
  })
  return new PasswordChangeError(failureKind)
}

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    confirmNewPassword: z.string().max(PASSWORD_MAX_LENGTH),
  })
  .superRefine((value, ctx) => {
    if (value.confirmNewPassword !== value.newPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmNewPassword'],
        message: PASSWORD_CONFIRM_MISMATCH,
      })
    }
  })

interface PasswordHashRow {
  readonly passwordHash: string | null
}

async function readPasswordHash(userId: string): Promise<PasswordHashRow | undefined> {
  const [row] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row
}

async function lockUser(handle: typeof db, userId: string): Promise<void> {
  // Shared with forgot/reset password so every password mutation for one user serialises here.
  await handle.execute(
    raw`select pg_advisory_xact_lock(${PASSWORD_RESET_LOCK_NAMESPACE}, hashtext(${userId}))`,
  )
}

export async function hasLocalPassword(userId: string): Promise<boolean> {
  const row = await readPasswordHash(userId)
  return row !== undefined && row.passwordHash !== null
}

interface LocalPasswordChange {
  readonly userId: string
  readonly originalHash: string
  readonly passwordHash: string
  readonly changedAt: Date
}

async function applyLocalPasswordChange(
  transaction: typeof db,
  change: LocalPasswordChange,
): Promise<void> {
  await lockUser(transaction, change.userId)

  const [row] = await transaction
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, change.userId))
    .limit(1)

  if (row === undefined || row.passwordHash === null) {
    throw new PasswordChangeError('noPassword')
  }
  if (row.passwordHash !== change.originalHash) {
    throw new PasswordChangeError('wrongCurrent')
  }

  await transaction
    .update(users)
    .set({ passwordHash: change.passwordHash, passwordChangedAt: change.changedAt })
    .where(eq(users.id, change.userId))

  await transaction
    .delete(passwordResetTokens)
    .where(and(eq(passwordResetTokens.userId, change.userId), isNull(passwordResetTokens.usedAt)))
}

export async function changePassword(input: {
  readonly userId: string
  readonly currentPassword: string
  readonly newPassword: string
  readonly actorIp: string | null
}): Promise<void> {
  const row = await readPasswordHash(input.userId)
  if (row === undefined || row.passwordHash === null) {
    throw await auditPasswordChangeFailure('noPassword', input.userId, input.actorIp)
  }

  const storedHash = row.passwordHash
  if (!(await verifyPassword(storedHash, input.currentPassword))) {
    throw await auditPasswordChangeFailure('wrongCurrent', input.userId, input.actorIp)
  }

  if (input.newPassword === input.currentPassword) {
    throw await auditPasswordChangeFailure('samePassword', input.userId, input.actorIp)
  }

  const passwordHash = await hashPassword(input.newPassword)
  // App clock, not now(): the cookie minted right after must never look older than this row.
  const changedAt = new Date()
  await db.transaction(async (transaction) => {
    await applyLocalPasswordChange(transaction, {
      userId: input.userId,
      originalHash: storedHash,
      passwordHash,
      changedAt,
    })
  })

  await recordAuditEvent({
    action: 'auth.password_changed',
    actorUserId: input.userId,
    actorIp: input.actorIp,
  })
}
