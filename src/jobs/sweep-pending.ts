import { and, eq, isNull, lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * Reclaims versions stuck in `pending` — a write that died between "insert the row" and "flip to
 * ready" (decision #21, US-2 AC4). Objects go first so a storage failure leaves the row behind
 * for the next run to retry, never an orphaned prefix with no row pointing at it.
 *
 * A version-less, non-current, non-trashed artifact is the same failure one layer up — its title
 * and slug are prompt-derived text with no version left to justify keeping the row (§8 data
 * retention). The parent delete is folded into the same transaction as the version delete so
 * nothing else can observe the artifact in that in-between state.
 *
 * Run it on a schedule, once a minute is plenty:
 *   * * * * * cd /app && pnpm exec tsx scripts/sweep-pending.ts
 */

export const PENDING_SWEEP_AFTER_MINUTES = 15

export interface SweepResult {
  readonly sweptVersionCount: number
  readonly failedVersionCount: number
  readonly sweptArtifactCount: number
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
  let sweptArtifactCount = 0

  for (const version of stale) {
    try {
      await store.deletePrefix(versionPrefix(version.artifactId, version.id))

      const reclaimed = await db.transaction(async (transaction) => {
        await transaction.delete(artifactVersions).where(eq(artifactVersions.id, version.id))

        const [remainingVersion] = await transaction
          .select({ id: artifactVersions.id })
          .from(artifactVersions)
          .where(eq(artifactVersions.artifactId, version.artifactId))
          .limit(1)

        if (remainingVersion !== undefined) return false

        const deletedArtifact = await transaction
          .delete(artifacts)
          .where(
            and(
              eq(artifacts.id, version.artifactId),
              isNull(artifacts.currentVersionId),
              isNull(artifacts.deletedAt),
            ),
          )
          .returning({ id: artifacts.id })

        return deletedArtifact.length > 0
      })

      sweptVersionCount += 1
      if (reclaimed) sweptArtifactCount += 1
    } catch (error) {
      failedVersionCount += 1
      const reason = error instanceof Error ? error.name : 'unknown error'
      console.error(`[enclave] sweep skipped version ${version.id} — ${reason}, will retry`)
    }
  }

  return { sweptVersionCount, failedVersionCount, sweptArtifactCount }
}
