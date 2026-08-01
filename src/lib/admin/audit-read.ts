import { and, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm'

import { db } from '@/db'
import { auditLog, type AuditAction, type AuditMetadata } from '@/db/schema/audit-log'
import { users } from '@/db/schema/users'
import { sanitizeMetadata } from '@/lib/audit'
import { encodeAuditCursor, type AuditFilter } from './audit-query'

/**
 * The A.12.4.1 audit viewer. It reads `audit_log` and joins `users` for the actor's address, and
 * that is the whole of it: `artifacts`, `artifact_versions`, and object storage are never touched,
 * so no response can carry an artifact's title, manifest, or bytes. An admin sees *that* a private
 * artifact was created and by whom — never what is in it (§5.1 branch 5, decision #26).
 *
 * Read access only. Nothing here writes, which is what lets the deployment run this surface under
 * the insert-and-select grant `src/db/audit-log-guard.ts` describes.
 */

export interface AuditEntry {
  readonly id: number
  readonly at: string
  readonly action: AuditAction
  readonly actorUserId: string | null
  readonly actorEmail: string | null
  readonly actorTokenId: string | null
  readonly actorShareLinkId: string | null
  readonly actorIp: string | null
  readonly artifactId: string | null
  readonly versionId: string | null
  readonly shareLinkId: string | null
  readonly metadata: AuditMetadata | null
}

export interface AuditPage {
  readonly items: readonly AuditEntry[]
  readonly nextCursor: string | null
}

/** Keyset on `(at desc, id desc)`, matching the `audit_log_at_idx` order the viewer pages in. */
function beforeCursor(filter: AuditFilter): SQL | undefined {
  if (filter.cursor === undefined) return undefined

  const cursorAt = new Date(filter.cursor.at)
  return or(
    lt(auditLog.at, cursorAt),
    and(eq(auditLog.at, cursorAt), lt(auditLog.id, filter.cursor.id)),
  )
}

function conditionsFor(filter: AuditFilter): SQL | undefined {
  const conditions = [
    filter.action === undefined ? undefined : eq(auditLog.action, filter.action),
    filter.actorUserId === undefined ? undefined : eq(auditLog.actorUserId, filter.actorUserId),
    filter.artifactId === undefined ? undefined : eq(auditLog.artifactId, filter.artifactId),
    filter.from === undefined ? undefined : gte(auditLog.at, filter.from),
    filter.to === undefined ? undefined : lte(auditLog.at, filter.to),
    beforeCursor(filter),
  ].filter((condition): condition is SQL => condition !== undefined)

  return conditions.length === 0 ? undefined : and(...conditions)
}

export async function readAuditPage(filter: AuditFilter): Promise<AuditPage> {
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      actorEmail: users.email,
      actorTokenId: auditLog.actorTokenId,
      actorShareLinkId: auditLog.actorShareLinkId,
      actorIp: auditLog.actorIp,
      artifactId: auditLog.artifactId,
      versionId: auditLog.versionId,
      shareLinkId: auditLog.shareLinkId,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(conditionsFor(filter))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    // One extra row answers "is there another page" without a second count query.
    .limit(filter.limit + 1)

  const page = rows.slice(0, filter.limit)
  const last = page.at(-1)

  return {
    items: page.map((row) => ({
      ...row,
      at: row.at.toISOString(),
      // The write path already refuses prompts and secrets; re-running it on read means a row
      // written before a redaction rule existed still cannot surface one (§8 log hygiene).
      metadata: sanitizeMetadata(row.metadata ?? undefined),
    })),
    nextCursor:
      rows.length > filter.limit && last !== undefined
        ? encodeAuditCursor({ at: last.at.toISOString(), id: last.id })
        : null,
  }
}
