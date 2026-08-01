import { and, desc, eq, isNull, sql as raw } from 'drizzle-orm'

import { db } from '@/db'
import { apiTokens } from '@/db/schema/api-tokens'
import { artifacts } from '@/db/schema/artifacts'
import { generations } from '@/db/schema/generations'
import { invites } from '@/db/schema/invites'
import { usageCounters } from '@/db/schema/usage-counters'
import { userProviderKeys } from '@/db/schema/user-provider-keys'
import { users, type UserRole } from '@/db/schema/users'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'

/**
 * User administration (§5.3, US-11). Everything here operates on rows *about* users — never on
 * artifact bytes or manifests. An admin's read of a private artifact stays a 404 through
 * `canRead` branch 5 (§5.1, decision #26); no query below joins artifact content of any kind.
 *
 * Deactivation is the reversible control and is what the console offers first. Deletion is
 * refused while the account still owns artifacts, because the alternative is a cascade that
 * silently removes content other people can currently see.
 */

export const ARTIFACTS_BLOCK_DELETION =
  'This user still owns artifacts. Reassign or delete them before removing the account.'
export const CANNOT_CHANGE_SELF = 'You cannot change your own role or access'
export const CANNOT_DELETE_SELF = 'You cannot delete your own account'

/** Postgres `foreign_key_violation` — a table added by a later slice still points at this user. */
const FOREIGN_KEY_VIOLATION = '23503'

export interface AdminUserSummary {
  readonly id: string
  readonly email: string
  readonly role: UserRole
  readonly isActive: boolean
  readonly createdAt: string
  readonly deactivatedAt: string | null
  /** Counts only. Titles stay out of every admin response (§5.1 branch 5). */
  readonly liveArtifactCount: number
  readonly orgArtifactCount: number
}

export interface SetUserAccessInput {
  readonly actorId: string
  readonly userId: string
  readonly isActive: boolean
  readonly role?: UserRole
  readonly actorIp?: string | null
}

export async function listUsers(): Promise<readonly AdminUserSummary[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
      deactivatedAt: users.deactivatedAt,
      liveArtifactCount: raw<number>`count(${artifacts.id})::int`,
      orgArtifactCount: raw<number>`count(${artifacts.id}) filter (where ${artifacts.visibility} = 'org')::int`,
    })
    .from(users)
    .leftJoin(artifacts, and(eq(artifacts.ownerId, users.id), isNull(artifacts.deletedAt)))
    .groupBy(users.id)
    .orderBy(desc(users.createdAt))

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
  }))
}

async function readUser(userId: string): Promise<AdminUserSummary> {
  const found = (await listUsers()).find((candidate) => candidate.id === userId)
  if (found === undefined) throw new HttpError('NOT_FOUND', 'No such user')
  return found
}

/**
 * Deactivating 401s the account's next request without touching its artifacts: `getSessionUser`
 * re-reads `is_active` on every request, so the session dies immediately, while an org-visible
 * artifact it owns stays readable to everyone else (§5.1 branch 3 asks about the *viewer*).
 *
 * Self-modification is refused. On an invite-only instance an admin who deactivates or demotes
 * themselves locks the console shut with no way back in — `/setup` is single-use and refuses to
 * run once any user exists. Because the actor is always an active admin and never the target, that
 * one rule is also what guarantees at least one active admin survives every call.
 */
export async function setUserAccess(input: SetUserAccessInput): Promise<AdminUserSummary> {
  if (input.actorId === input.userId) {
    throw new HttpError('VALIDATION_FAILED', CANNOT_CHANGE_SELF)
  }

  const current = await readUser(input.userId)

  const [updated] = await db
    .update(users)
    .set({
      isActive: input.isActive,
      deactivatedAt: input.isActive ? null : raw`now()`,
      ...(input.role === undefined ? {} : { role: input.role }),
    })
    .where(eq(users.id, input.userId))
    .returning({ id: users.id })

  if (updated === undefined) throw new HttpError('NOT_FOUND', 'No such user')

  if (current.isActive && !input.isActive) {
    await recordAuditEvent({
      action: 'user.deactivate',
      actorUserId: input.actorId,
      actorIp: input.actorIp ?? null,
      metadata: { userId: input.userId, previousRole: current.role },
    })
  }

  return readUser(input.userId)
}

export interface DeleteUserInput {
  readonly actorId: string
  readonly userId: string
}

/**
 * Never a cascade. Any artifact the account still owns — org-visible, private, or sitting in the
 * 30-day trash — blocks the delete and is named in `details.blockingArtifactIds`, so the operator
 * reassigns or deletes it deliberately instead of discovering it gone.
 */
async function assertNoOwnedArtifacts(userId: string): Promise<void> {
  const owned = await db
    .select({ id: artifacts.id, visibility: artifacts.visibility })
    .from(artifacts)
    .where(eq(artifacts.ownerId, userId))

  if (owned.length === 0) return

  throw new HttpError('VALIDATION_FAILED', ARTIFACTS_BLOCK_DELETION, {
    status: 409,
    details: {
      blockingArtifactIds: owned.map((artifact) => artifact.id),
      orgVisibleCount: owned.filter((artifact) => artifact.visibility === 'org').length,
    },
  })
}

export async function deleteUser(input: DeleteUserInput): Promise<void> {
  if (input.actorId === input.userId) {
    throw new HttpError('VALIDATION_FAILED', CANNOT_DELETE_SELF)
  }

  await readUser(input.userId)
  await assertNoOwnedArtifacts(input.userId)

  try {
    await db.transaction(async (transaction) => {
      await transaction.delete(apiTokens).where(eq(apiTokens.userId, input.userId))
      await transaction.delete(usageCounters).where(eq(usageCounters.userId, input.userId))
      await transaction.delete(userProviderKeys).where(eq(userProviderKeys.userId, input.userId))
      await transaction.delete(generations).where(eq(generations.userId, input.userId))
      await transaction.delete(invites).where(eq(invites.createdBy, input.userId))
      // Keeps `used_at`, so a redeemed invite still reads as redeemed after its member is gone.
      await transaction.update(invites).set({ usedBy: null }).where(eq(invites.usedBy, input.userId))
      await transaction.delete(users).where(eq(users.id, input.userId))
    })
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw new HttpError(
        'VALIDATION_FAILED',
        'This user still has data attached elsewhere on the instance.',
        { status: 409 },
      )
    }
    throw error
  }

  // `audit_log.actor_user_id` carries no foreign key by design, so the trail outlives the account.
  await recordAuditEvent({
    action: 'user.deactivate',
    actorUserId: input.actorId,
    metadata: { userId: input.userId, deleted: true },
  })
}

function isForeignKeyViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { readonly code?: unknown }).code
  return code === FOREIGN_KEY_VIOLATION
}
