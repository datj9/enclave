import { and, eq, lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions } from '@/db/schema/artifacts'
import { versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * Reclaims versions stuck in `pending` — a write that died between "insert the row" and "flip to
 * ready" (decision #21, US-2 AC4). Objects go first so a storage failure leaves the row behind
 * for the next run to retry, never an orphaned prefix with no row pointing at it.
 *
 * Run it on a schedule, once a minute is plenty:
 *   * * * * * cd /app && pnpm exec tsx scripts/sweep-pending.ts
 */

export const PENDING_SWEEP_AFTER_MINUTES = 15

export interface SweepResult {
  readonly sweptVersionCount: number
  readonly failedVersionCount: number
}

export async function sweepPendingVersions(
  store: ObjectStore = objectStore(),
): Promise<SweepResult> {
  const stale = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.status, 'pending'),
        // Postgres `now()`, never app-server time (§7 clock skew).
        lt(
          artifactVersions.createdAt,
          sql`now() - make_interval(mins => ${PENDING_SWEEP_AFTER_MINUTES})`,
        ),
      ),
    )

  let sweptVersionCount = 0
  let failedVersionCount = 0

  for (const version of stale) {
    try {
      await store.deletePrefix(versionPrefix(version.artifactId, version.id))
      await db.delete(artifactVersions).where(eq(artifactVersions.id, version.id))
      sweptVersionCount += 1
    } catch (error) {
      failedVersionCount += 1
      const reason = error instanceof Error ? error.name : 'unknown error'
      console.error(`[enclave] sweep skipped version ${version.id} — ${reason}, will retry`)
    }
  }

  return { sweptVersionCount, failedVersionCount }
}
