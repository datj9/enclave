import { and, eq, isNull, sql as raw } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from './password'
import { PASSWORD_RESET_LOCK_NAMESPACE } from './forgot-password'

export const CURRENT_PASSWORD_INCORRECT = 'Current password is incorrect'
export const NO_PASSWORD_ACCOUNT = 'This account has no password'
export const CHOOSE_DIFFERENT_PASSWORD = 'Choose a different password'
export const PASSWORD_TOO_SHORT = 'Enter a password of at least 12 characters'
export const PASSWORD_CONFIRM_MISMATCH = 'New password and confirmation do not match'
export const PASSWORD_UPDATED = 'Password updated.'
export const OIDC_ONLY_PASSWORD_COPY =
  'This account signs in with your identity provider and has no password.'

export const PASSWORD_CHANGE_FAILURE_REASONS = [
  'wrong_current',
  'no_password',
  'malformed',
  'same_password',
] as const
export type PasswordChangeFailureReason = (typeof PASSWORD_CHANGE_FAILURE_REASONS)[number]

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

function failNoPassword(userId: string, actorIp: string | null): never {
  void recordAuditEvent({
    action: 'auth.password_change_failed',
    actorUserId: userId,
    actorIp,
    metadata: { reason: 'no_password' },
  })
  throw new HttpError('FORBIDDEN', NO_PASSWORD_ACCOUNT)
}

function failWrongCurrent(userId: string, actorIp: string | null): never {
  void recordAuditEvent({
    action: 'auth.password_change_failed',
    actorUserId: userId,
    actorIp,
    metadata: { reason: 'wrong_current' },
  })
  throw new HttpError('UNAUTHENTICATED', CURRENT_PASSWORD_INCORRECT)
}

function failSamePassword(userId: string, actorIp: string | null): never {
  void recordAuditEvent({
    action: 'auth.password_change_failed',
    actorUserId: userId,
    actorIp,
    metadata: { reason: 'same_password' },
  })
  throw new HttpError('VALIDATION_FAILED', CHOOSE_DIFFERENT_PASSWORD)
}

async function applyLocalPasswordChange(
  transaction: typeof db,
  userId: string,
  originalHash: string,
  passwordHash: string,
): Promise<void> {
  await lockUser(transaction, userId)

  const [row] = await transaction
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (row === undefined || row.passwordHash === null) {
    throw new HttpError('FORBIDDEN', NO_PASSWORD_ACCOUNT)
  }
  if (row.passwordHash !== originalHash) {
    throw new HttpError('UNAUTHENTICATED', CURRENT_PASSWORD_INCORRECT)
  }

  await transaction
    .update(users)
    .set({ passwordHash, passwordChangedAt: raw`now()` })
    .where(eq(users.id, userId))

  await transaction
    .delete(passwordResetTokens)
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))
}

export async function changePassword(input: {
  readonly userId: string
  readonly currentPassword: string
  readonly newPassword: string
  readonly actorIp: string | null
}): Promise<void> {
  const row = await readPasswordHash(input.userId)
  if (row === undefined || row.passwordHash === null) {
    failNoPassword(input.userId, input.actorIp)
  }

  const storedHash = row.passwordHash
  if (!(await verifyPassword(storedHash, input.currentPassword))) {
    failWrongCurrent(input.userId, input.actorIp)
  }

  if (input.newPassword === input.currentPassword) {
    failSamePassword(input.userId, input.actorIp)
  }

  const passwordHash = await hashPassword(input.newPassword)
  await db.transaction(async (transaction) => {
    await applyLocalPasswordChange(transaction, input.userId, storedHash, passwordHash)
  })

  await recordAuditEvent({
    action: 'auth.password_changed',
    actorUserId: input.userId,
    actorIp: input.actorIp,
  })
}
