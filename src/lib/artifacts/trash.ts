import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifacts, type Visibility } from '@/db/schema/artifacts'
import { env } from '@/env'

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

/**
 * Counted in Postgres, never from `Date.now()`: the retention window is judged on the database
 * clock everywhere else (§7), and a trash view that disagreed with the purge job by an hour of
 * clock skew would promise time the artifact does not have.
 */
function daysRemainingExpression(retentionDays: number) {
  return sql<number>`greatest(
    ceil(
      extract(
        epoch from
          ${artifacts.deletedAt} + make_interval(days => ${retentionDays}) - now()
      ) / 86400
    ),
    0
  )::int`
}

export async function listTrashedArtifacts(
  ownerId: string,
  retentionDays: number = env.TRASH_RETENTION_DAYS,
): Promise<readonly TrashedArtifact[]> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      visibility: artifacts.visibility,
      deletedAt: artifacts.deletedAt,
      daysRemaining: daysRemainingExpression(retentionDays),
    })
    .from(artifacts)
    .where(and(eq(artifacts.ownerId, ownerId), isNotNull(artifacts.deletedAt)))
    .orderBy(desc(artifacts.deletedAt))

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    // `isNotNull` above already guarantees this; the fallback exists because the column's type
    // stays nullable and the alternative would be a non-null assertion.
    deletedAt: row.deletedAt?.toISOString() ?? '',
    daysRemaining: row.daysRemaining,
  }))
}
