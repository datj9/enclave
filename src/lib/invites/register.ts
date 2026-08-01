import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { users } from '@/db/schema/users'
import { env } from '@/env'
import { recordAuditEvent } from '@/lib/audit'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from '@/lib/auth/password'
import { HttpError } from '@/lib/http'
import {
  assertInviteAcceptsEmail,
  claimInvite,
  lockInvite,
  requireRedeemableToken,
  requireRedeemableUnderLock,
  type RedeemableInvite,
} from './redeem'

/**
 * Password self-registration, which exists only where an invite authorises it — or where the
 * operator has set `ALLOW_OPEN_REGISTRATION=true` and accepted what decision #25 spells out: on an
 * open instance, "visible to the organization" means visible to anyone who signs up.
 *
 * The invite claim and the `users` insert share one transaction under one advisory lock, so two
 * requests presenting the same token produce exactly one member and one 410.
 */

export const REGISTRATION_CLOSED = 'This instance is invite-only'
export const EMAIL_TAKEN = 'An account already uses this email address'

export const signupSchema = z.object({
  // Same normalisation as `credentialsSchema`: the stored column is citext, so lowercase is what
  // the lookup and the invite's own address are compared against.
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  inviteToken: z.string().trim().min(1).optional(),
})

export type SignupInput = z.infer<typeof signupSchema>

export interface RegisteredMember {
  readonly id: string
  readonly inviteId: string | null
}

/**
 * Resolves the invite that authorises this signup. `null` means open registration is on and no
 * token was presented; an invalid token throws the §5.3 404/410 even when the flag is true, so a
 * stale link never silently becomes an open signup.
 */
async function authorisingInvite(input: SignupInput): Promise<RedeemableInvite | null> {
  if (input.inviteToken !== undefined) {
    const invite = await requireRedeemableToken(input.inviteToken)
    assertInviteAcceptsEmail(invite, input.email)
    return invite
  }

  if (env.ALLOW_OPEN_REGISTRATION) return null
  throw new HttpError('NOT_FOUND', REGISTRATION_CLOSED)
}

async function assertEmailAvailable(email: string): Promise<void> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  if (existing !== undefined) {
    throw new HttpError('VALIDATION_FAILED', EMAIL_TAKEN, { status: 409 })
  }
}

/**
 * Creates the member and marks the invite used. Hashing happens before the transaction so the
 * lock is held for two queries, not for argon2's ~50 ms of deliberate work — the same shape
 * `createFirstAdmin` uses.
 */
export async function registerMember(
  input: SignupInput,
  actorIp?: string | null,
): Promise<RegisteredMember> {
  const invite = await authorisingInvite(input)
  await assertEmailAvailable(input.email)
  const passwordHash = await hashPassword(input.password)

  const registered = await db.transaction(async (transaction) => {
    if (invite !== null) {
      await lockInvite(transaction, invite.id)
      await requireRedeemableUnderLock(transaction, invite.id)
    }

    const [created] = await transaction
      .insert(users)
      .values({ email: input.email, passwordHash, oidcSub: null, role: 'member', isActive: true })
      .onConflictDoNothing()
      .returning({ id: users.id })

    // Lost the email race with a concurrent signup: the invite stays unclaimed for its owner.
    if (created === undefined) throw new HttpError('VALIDATION_FAILED', EMAIL_TAKEN, { status: 409 })

    if (invite !== null) await claimInvite(transaction, invite.id, created.id)
    return { id: created.id, inviteId: invite?.id ?? null }
  })

  await recordAuditEvent({
    action: 'user.create',
    actorUserId: registered.id,
    actorIp: actorIp ?? null,
    metadata: {
      role: 'member',
      via: registered.inviteId === null ? 'open-registration' : 'invite',
      ...(registered.inviteId === null ? {} : { inviteId: registered.inviteId }),
    },
  })

  return registered
}
