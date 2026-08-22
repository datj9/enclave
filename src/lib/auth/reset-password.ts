import { and, eq, isNull, sql as raw } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password'
import { hashPasswordResetToken, isPasswordResetTokenShaped } from './password-reset-tokens'
import { PASSWORD_RESET_LOCK_NAMESPACE } from './forgot-password'

/**
 * The consume half of password reset (grill-result §8). A reset link is a single-use capability
 * URL; validity is never distinguished from expiry or reuse in the client message.
 *
 * Never log a token value and never put one in an audit row (§8 log hygiene).
 */

export const GENERIC_RESET_FAILURE = 'This reset link is invalid or has expired.'

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
})

interface ResetTokenRow {
  readonly id: string
  readonly userId: string
  readonly usedAt: Date | null
  readonly isExpired: boolean
}

function resetTokenColumns() {
  return {
    id: passwordResetTokens.id,
    userId: passwordResetTokens.userId,
    usedAt: passwordResetTokens.usedAt,
    isExpired: raw<boolean>`${passwordResetTokens.expiresAt} <= now()`,
  }
}

async function readTokenByHash(
  handle: typeof db,
  tokenHash: Buffer,
): Promise<ResetTokenRow | undefined> {
  const [row] = await handle
    .select(resetTokenColumns())
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1)
  return row
}

function assertConsumable(row: ResetTokenRow | undefined, actorIp: string | null): ResetTokenRow {
  if (row === undefined || row.usedAt !== null || row.isExpired) {
    void recordAuditEvent({
      action: 'auth.password_reset_failed',
      actorUserId: row?.userId ?? null,
      actorIp,
      metadata: { reason: 'invalid_token' },
    })
    throw new HttpError('VALIDATION_FAILED', GENERIC_RESET_FAILURE)
  }
  return row
}

async function lockUser(handle: typeof db, userId: string): Promise<void> {
  await handle.execute(
    raw`select pg_advisory_xact_lock(${PASSWORD_RESET_LOCK_NAMESPACE}, hashtext(${userId}))`,
  )
}

async function assertUserActive(handle: typeof db, userId: string): Promise<void> {
  const [user] = await handle
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (user === undefined || !user.isActive) {
    throw new HttpError('VALIDATION_FAILED', GENERIC_RESET_FAILURE)
  }
}

async function applyPasswordChange(
  handle: typeof db,
  userId: string,
  passwordHash: string,
  tokenId: string,
): Promise<void> {
  await handle
    .update(users)
    .set({ passwordHash, passwordChangedAt: raw`now()` })
    .where(eq(users.id, userId))

  const claimed = await handle
    .update(passwordResetTokens)
    .set({ usedAt: raw`now()` })
    .where(and(eq(passwordResetTokens.id, tokenId), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id })

  if (claimed.length !== 1) {
    throw new HttpError('VALIDATION_FAILED', GENERIC_RESET_FAILURE)
  }

  await handle
    .delete(passwordResetTokens)
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))
}

export async function completePasswordReset(input: {
  readonly token: string
  readonly password: string
  readonly actorIp: string | null
}): Promise<{ readonly userId: string }> {
  if (!isPasswordResetTokenShaped(input.token)) {
    await recordAuditEvent({
      action: 'auth.password_reset_failed',
      actorIp: input.actorIp,
      metadata: { reason: 'malformed' },
    })
    throw new HttpError('VALIDATION_FAILED', GENERIC_RESET_FAILURE)
  }

  const passwordHash = await hashPassword(input.password)
  const tokenHash = hashPasswordResetToken(input.token)

  const row = await db.transaction(async (transaction) => {
    const firstRead = await readTokenByHash(transaction, tokenHash)
    const firstRow = assertConsumable(firstRead, input.actorIp)

    await lockUser(transaction, firstRow.userId)
    const lockedRow = assertConsumable(await readTokenByHash(transaction, tokenHash), input.actorIp)

    await assertUserActive(transaction, lockedRow.userId)
    await applyPasswordChange(transaction, lockedRow.userId, passwordHash, lockedRow.id)

    return { id: lockedRow.id, userId: lockedRow.userId }
  })

  await recordAuditEvent({
    action: 'auth.password_reset_completed',
    actorUserId: row.userId,
    actorIp: input.actorIp,
    metadata: { resetTokenId: row.id },
  })

  return { userId: row.userId }
}
