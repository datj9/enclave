import { desc, eq, sql as raw } from 'drizzle-orm'

import { db } from '@/db'
import { invites } from '@/db/schema/invites'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { inviteUrl, mintInviteToken } from './tokens'

/**
 * The admin side of invites (§5.3): issue, list, revoke. `POST /api/v1/invites` is the only
 * response that ever carries a token value, exactly as `POST /api/v1/tokens` is for API tokens.
 *
 * Never log an invite token and never put one in an audit row or an error message (§8).
 */

export const DEFAULT_INVITE_TTL_HOURS = 72
export const MAX_INVITE_TTL_HOURS = 24 * 30

const MILLIS_PER_HOUR = 3_600_000

export interface CreateInviteInput {
  readonly createdBy: string
  readonly email: string | null
  readonly expiresInHours: number
  readonly actorIp?: string | null
}

/** `token` and `url` are readable once. Nothing recovers them afterwards. */
export interface CreatedInvite {
  readonly inviteId: string
  readonly token: string
  readonly url: string
  readonly expiresAt: string
}

export type InviteStatus = 'outstanding' | 'used' | 'revoked' | 'expired'

export interface InviteSummary {
  readonly id: string
  readonly email: string | null
  readonly status: InviteStatus
  readonly expiresAt: string
  readonly usedAt: string | null
  readonly usedBy: string | null
  readonly revokedAt: string | null
  readonly createdBy: string
  readonly createdAt: string
}

export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  const { plaintext, tokenHash } = mintInviteToken()
  const expiresAt = new Date(Date.now() + input.expiresInHours * MILLIS_PER_HOUR)

  const [row] = await db
    .insert(invites)
    .values({ email: input.email, tokenHash, createdBy: input.createdBy, expiresAt })
    .returning({ id: invites.id })

  if (row === undefined) throw new HttpError('INTERNAL_ERROR', 'Could not create the invite')

  await recordAuditEvent({
    action: 'user.invite',
    actorUserId: input.createdBy,
    actorIp: input.actorIp ?? null,
    metadata: { inviteId: row.id, email: input.email, expiresAt: expiresAt.toISOString() },
  })

  return {
    inviteId: row.id,
    token: plaintext,
    url: inviteUrl(plaintext),
    expiresAt: expiresAt.toISOString(),
  }
}

function statusOf(row: {
  readonly usedAt: Date | null
  readonly revokedAt: Date | null
  readonly expiresAt: Date
}): InviteStatus {
  if (row.usedAt !== null) return 'used'
  if (row.revokedAt !== null) return 'revoked'
  return row.expiresAt.getTime() <= Date.now() ? 'expired' : 'outstanding'
}

/** Never selects `token_hash`: the list must not expose anything derived from the secret. */
export async function listInvites(): Promise<readonly InviteSummary[]> {
  const rows = await db
    .select({
      id: invites.id,
      email: invites.email,
      expiresAt: invites.expiresAt,
      usedAt: invites.usedAt,
      usedBy: invites.usedBy,
      revokedAt: invites.revokedAt,
      createdBy: invites.createdBy,
      createdAt: invites.createdAt,
    })
    .from(invites)
    .orderBy(desc(invites.createdAt))

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: statusOf(row),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt?.toISOString() ?? null,
    usedBy: row.usedBy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * Revoking an already-used invite is a no-op rather than an error: `used_at` is what the gate
 * reads, and rewriting history to say "revoked" would misreport who redeemed it.
 */
export async function revokeInvite(inviteId: string): Promise<boolean> {
  const revoked = await db
    .update(invites)
    .set({ revokedAt: raw`now()` })
    .where(eq(invites.id, inviteId))
    .returning({ id: invites.id })

  return revoked.length === 1
}
