import { and, eq, gt, isNull, sql as raw } from 'drizzle-orm'

import { db, type Database } from '@/db'
import { invites } from '@/db/schema/invites'
import { HttpError } from '@/lib/http'
import { hashInviteToken, isInviteTokenShaped } from './tokens'

/**
 * The redemption gate. An invite is single-use, and "single" has to hold when two requests present
 * the same token at the same instant — so every claim serialises on a `pg_advisory_xact_lock`
 * keyed by the invite's own id, the same shape S1 uses for `/setup` (src/lib/auth/setup.ts).
 * Without it both transactions read `used_at is null` under READ COMMITTED and both create a user.
 *
 * Nothing here logs or returns a token value (§8 log hygiene).
 */

/** Distinct from `SETUP_LOCK_KEY`'s single-argument space, so the two never contend. */
const INVITE_LOCK_NAMESPACE = 8_531_208

export const INVITE_ALREADY_USED = 'This invite has already been used'
export const INVITE_EXPIRED = 'This invite has expired'
export const INVITE_REVOKED = 'This invite has been revoked'
export const INVITE_NOT_FOUND = 'No such invite'
export const INVITE_EMAIL_MISMATCH = 'This invite was issued for a different email address'

/** Either the pooled handle or a transaction, so a claim can join a caller's transaction. */
export type DbHandle = Database | Parameters<Parameters<Database['transaction']>[0]>[0]

export interface RedeemableInvite {
  readonly id: string
  readonly email: string | null
}

interface InviteState {
  readonly id: string
  readonly email: string | null
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
  readonly isExpired: boolean
}

/**
 * `expires_at` is compared in Postgres `now()`, never app-server time — the same clock the
 * `used_at` write happens on (§7 clock skew).
 */
function inviteStateColumns() {
  return {
    id: invites.id,
    email: invites.email,
    usedAt: invites.usedAt,
    revokedAt: invites.revokedAt,
    isExpired: raw<boolean>`${invites.expiresAt} <= now()`,
  }
}

async function readInviteById(handle: DbHandle, inviteId: string): Promise<InviteState | undefined> {
  const [state] = await handle
    .select(inviteStateColumns())
    .from(invites)
    .where(eq(invites.id, inviteId))
    .limit(1)
  return state
}

/** Throws the §5.3 error the state deserves: 410 for used, revoked, or expired; 404 for unknown. */
export function assertRedeemable(state: InviteState | undefined): RedeemableInvite {
  if (state === undefined) throw new HttpError('NOT_FOUND', INVITE_NOT_FOUND)

  if (state.usedAt !== null) {
    throw new HttpError('VALIDATION_FAILED', INVITE_ALREADY_USED, { status: 410 })
  }
  if (state.revokedAt !== null) {
    throw new HttpError('VALIDATION_FAILED', INVITE_REVOKED, { status: 410 })
  }
  if (state.isExpired) {
    throw new HttpError('VALIDATION_FAILED', INVITE_EXPIRED, { status: 410 })
  }

  return { id: state.id, email: state.email }
}

/**
 * Resolves a plaintext token to a redeemable invite, throwing the exact 404/410 the caller should
 * return. The lookup is by digest, so the plaintext never reaches a query parameter log.
 */
export async function requireRedeemableToken(plaintext: string): Promise<RedeemableInvite> {
  if (!isInviteTokenShaped(plaintext)) throw new HttpError('NOT_FOUND', INVITE_NOT_FOUND)

  const [state] = await db
    .select(inviteStateColumns())
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteToken(plaintext)))
    .limit(1)

  return assertRedeemable(state)
}

/** `null` rather than a throw: the caller decides whether a missing invite is a rejection. */
export async function findRedeemableToken(plaintext: string): Promise<RedeemableInvite | null> {
  try {
    return await requireRedeemableToken(plaintext)
  } catch {
    return null
  }
}

/**
 * The OIDC seam's lookup (src/lib/auth/oidc.ts): an outstanding invite naming the asserted email.
 * A link-only invite — `email is null` — cannot be claimed this way, because nothing would bind it
 * to the identity the provider asserted.
 */
export async function findRedeemableInviteByEmail(email: string): Promise<RedeemableInvite | null> {
  const [invite] = await db
    .select({ id: invites.id, email: invites.email })
    .from(invites)
    .where(
      and(
        eq(invites.email, email),
        isNull(invites.usedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, raw`now()`),
      ),
    )
    .limit(1)

  return invite ?? null
}

/** Serialises every claim of one invite. Must be the first statement of the claiming transaction. */
export async function lockInvite(handle: DbHandle, inviteId: string): Promise<void> {
  await handle.execute(
    raw`select pg_advisory_xact_lock(${INVITE_LOCK_NAMESPACE}, hashtext(${inviteId}))`,
  )
}

/** Re-asserts redeemability under the lock, so a claim that lost the race throws 410, not a user. */
export async function requireRedeemableUnderLock(
  handle: DbHandle,
  inviteId: string,
): Promise<RedeemableInvite> {
  return assertRedeemable(await readInviteById(handle, inviteId))
}

/** The same check for the OIDC path, which answers with a rejection reason rather than a status. */
export async function isInviteRedeemable(handle: DbHandle, inviteId: string): Promise<boolean> {
  const state = await readInviteById(handle, inviteId)
  if (state === undefined) return false
  return state.usedAt === null && state.revokedAt === null && !state.isExpired
}

/**
 * `used_at is null` in the predicate as well as under the lock: if the advisory lock is ever
 * dropped by a refactor, the row still cannot be claimed twice.
 */
export async function claimInvite(
  handle: DbHandle,
  inviteId: string,
  userId: string,
): Promise<boolean> {
  const claimed = await handle
    .update(invites)
    .set({ usedAt: raw`now()`, usedBy: userId })
    .where(and(eq(invites.id, inviteId), isNull(invites.usedAt)))
    .returning({ id: invites.id })

  return claimed.length === 1
}

export function emailMismatch(): HttpError {
  return new HttpError('VALIDATION_FAILED', INVITE_EMAIL_MISMATCH)
}

/** A named invite is bound to its address; a link-only invite accepts whatever address signs up. */
export function assertInviteAcceptsEmail(invite: RedeemableInvite, email: string): void {
  if (invite.email !== null && invite.email.toLowerCase() !== email.toLowerCase()) {
    throw emailMismatch()
  }
}
