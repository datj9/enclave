import { and, desc, eq, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm'

import { db } from '@/db'
import { artifacts, type Visibility } from '@/db/schema/artifacts'
import { env } from '@/env'
import { encodeListCursor, type ListCursor, type ListQuery } from './list-query'

/**
 * The owner's trash (US-10). `canRead` branch 1 hides a deleted artifact from every read path, so
 * this listing is the separate path its comment points at — owner-scoped in SQL rather than
 * through the gate, and it never exposes a way to open the artifact, only to restore it.
 */

export interface TrashedArtifact {
  readonly id: string
  readonly title: string
  readonly visibility: Visibility
  readonly deletedAt: string
  /** Whole days until the purge job may take it. Floors at 0 for a row already past the window. */
  readonly daysRemaining: number
}

export interface TrashPage {
  readonly items: readonly TrashedArtifact[]
  readonly nextCursor: string | null
}

/**
 * Counted in Postgres, never from `Date.now()`: the retention window is judged on the database
 * clock everywhere else (§7), and a trash view that disagreed with the purge job by an hour of
 * clock skew would promise time the artifact does not have. `hours`, not `days`: `days` is a
 * calendar field on a timestamptz and drifts across a DST transition (TASK-6) — the purge
 * predicate must stay textually identical to this one apart from `lt` vs `gte`.
 */
function daysRemainingExpression(retentionDays: number) {
  return sql<number>`greatest(
    ceil(
      extract(
        epoch from
          ${artifacts.deletedAt} + make_interval(hours => ${retentionDays * 24}) - now()
      ) / 86400
    ),
    0
  )::int`
}

/**
 * Keyset predicate matching the `(deleted_at desc, id desc)` order exactly. The shared cursor
 * codec's timestamp slot carries `deleted_at` here — the cursor is opaque to callers and its
 * shape is identical to the one `listOwnedArtifacts` issues.
 */
function afterCursor(cursor: ListCursor): SQL | undefined {
  const deletedAt = new Date(cursor.createdAt)
  return or(
    lt(artifacts.deletedAt, deletedAt),
    and(eq(artifacts.deletedAt, deletedAt), lt(artifacts.id, cursor.id)),
  )
}

export async function listTrashedArtifacts(
  ownerId: string,
  query: ListQuery,
  retentionDays: number = env.TRASH_RETENTION_DAYS,
): Promise<TrashPage> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      visibility: artifacts.visibility,
      deletedAt: artifacts.deletedAt,
      daysRemaining: daysRemainingExpression(retentionDays),
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.ownerId, ownerId),
        isNotNull(artifacts.deletedAt),
        query.cursor === undefined ? undefined : afterCursor(query.cursor),
      ),
    )
    .orderBy(desc(artifacts.deletedAt), desc(artifacts.id))
    // One extra row answers "is there a next page" without a second count query.
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  const hasMore = rows.length > query.limit

  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      visibility: row.visibility,
      // `isNotNull` above already guarantees this; the fallback exists because the column's type
      // stays nullable and the alternative would be a non-null assertion.
      deletedAt: row.deletedAt?.toISOString() ?? '',
      daysRemaining: row.daysRemaining,
    })),
    nextCursor:
      hasMore && last !== undefined && last.deletedAt !== null
        ? encodeListCursor({ createdAt: last.deletedAt.toISOString(), id: last.id })
        : null,
  }
}
