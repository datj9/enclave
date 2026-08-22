import { and, eq, isNull, sql as raw } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { env } from '@/env'
import { recordAuditEvent } from '@/lib/audit'
import { isMailConfigured, sendMail } from '@/lib/mail/smtp'
import { mintPasswordResetToken, passwordResetUrl } from './password-reset-tokens'

/**
 * The forgot-password half of password reset (grill-result §8). Every response is the same
 * generic success whether or not the email is known, SMTP is on, or the mail could be sent — the
 * only observable difference is an audit row, and only an operator can read those.
 *
 * Never log a token value and never put one in an audit row (§8 log hygiene).
 */

export const GENERIC_FORGOT_PASSWORD_SUCCESS =
  'If that email is on this instance, we sent a reset link.'

/** Same trim + lowercase + max 320 normalisation as `credentialsSchema`. */
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
})

export const PASSWORD_RESET_EMAIL_SUBJECT = 'Reset your enclave password'

export function passwordResetEmailText(resetUrl: string): string {
  return [
    'Reset your password by opening this link:',
    '',
    resetUrl,
    '',
    'This link expires in 1 hour.',
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n')
}

/**
 * Advisory-lock namespace for password reset, distinct from setup (8_531_207) and invites
 * (8_531_208) so concurrent forgot+reset on one user serialise here and nowhere else. Consume in
 * Task 7 uses the same key.
 */
export const PASSWORD_RESET_LOCK_NAMESPACE = 8_531_209

/** The raw lookup result; `isActive` and `passwordHash` decide eligibility, never the caller. */
interface UserRow {
  readonly id: string
  readonly isActive: boolean
  readonly passwordHash: string | null
}

async function findResettableUser(email: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select({ id: users.id, isActive: users.isActive, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return row
}

/** One row per user at a time: unused rows are replaced, not accumulated — audit_log is the history. */
async function replaceOutstandingTokens(userId: string, tokenHash: Buffer): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(
      raw`select pg_advisory_xact_lock(${PASSWORD_RESET_LOCK_NAMESPACE}, hashtext(${userId}))`,
    )

    await transaction
      .delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))

    await transaction.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      expiresAt: raw`now() + make_interval(secs => ${env.PASSWORD_RESET_TTL_SECONDS})`,
    })
  })
}

/** Mail failure is never a 5xx: the requester sees the same generic success either way. */
async function deliverResetMail(to: string, plaintext: string): Promise<boolean> {
  try {
    await sendMail({
      to,
      subject: PASSWORD_RESET_EMAIL_SUBJECT,
      text: passwordResetEmailText(passwordResetUrl(plaintext)),
    })
    return true
  } catch {
    console.error('[enclave] password reset mail failed')
    return false
  }
}

export async function requestPasswordReset(input: {
  readonly email: string
  readonly actorIp: string | null
}): Promise<void> {
  const row = await findResettableUser(input.email)

  if (row === undefined || !row.isActive || row.passwordHash === null || !isMailConfigured()) {
    await recordAuditEvent({
      action: 'auth.password_reset_requested',
      actorUserId: row?.id ?? null,
      actorIp: input.actorIp,
      metadata: { mailed: false },
    })
    return
  }

  const minted = mintPasswordResetToken()
  await replaceOutstandingTokens(row.id, minted.tokenHash)
  const mailed = await deliverResetMail(input.email, minted.plaintext)

  await recordAuditEvent({
    action: 'auth.password_reset_requested',
    actorUserId: row.id,
    actorIp: input.actorIp,
    metadata: { mailed },
  })
}
