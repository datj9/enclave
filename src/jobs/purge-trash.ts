import { and, eq, isNotNull, lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { env } from '@/env'
import { recordAuditEvent } from '@/lib/audit'
import { artifactPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * Hard-deletes what has sat in the trash past `TRASH_RETENTION_DAYS` (US-10). Objects go first,
 * exactly as the pending sweeper does: a storage failure then leaves the rows behind for the next
 * run rather than orphaning a prefix nothing points at.
 *
 * The `artifact.purge` row outlives everything it names — `audit_log` carries no foreign keys for
 * this reason (§8, A.12.4.1), so the artifact id stays readable after the artifact is gone.
 *
 * Idempotent by construction: a purged artifact no longer matches the due query, so a second run
 * over the same one does nothing at all.
 *
 * Run it on the same schedule as the audit prune:
 *   0 3 * * * cd /app && pnpm exec tsx scripts/purge-trash.ts
 */

export interface PurgeTrashResult {
  readonly purgedArtifactCount: number
  readonly failedArtifactCount: number
  readonly retentionDays: number
}

export async function purgeTrashedArtifacts(
  store: ObjectStore = objectStore(),
  retentionDays: number = env.TRASH_RETENTION_DAYS,
): Promise<PurgeTrashResult> {
  const due = await db
    .select({ id: artifacts.id, ownerId: artifacts.ownerId })
    .from(artifacts)
    .where(
      and(
        isNotNull(artifacts.deletedAt),
        // Postgres `now()`, never app-server time (§7 clock skew).
        lt(artifacts.deletedAt, sql`now() - make_interval(days => ${retentionDays})`),
      ),
    )

  let purgedArtifactCount = 0
  let failedArtifactCount = 0

  for (const artifact of due) {
    try {
      await store.deletePrefix(artifactPrefix(artifact.id))

      await db.transaction(async (transaction) => {
        await transaction
          .delete(artifactVersions)
          .where(eq(artifactVersions.artifactId, artifact.id))
        await transaction.delete(artifacts).where(eq(artifacts.id, artifact.id))
      })

      await recordAuditEvent({
        action: 'artifact.purge',
        actorUserId: artifact.ownerId,
        artifactId: artifact.id,
        metadata: { retentionDays },
      })
      purgedArtifactCount += 1
    } catch (error) {
      failedArtifactCount += 1
      const reason = error instanceof Error ? error.name : 'unknown error'
      console.error(`[enclave] purge skipped artifact ${artifact.id} — ${reason}, will retry`)
    }
  }

  return { purgedArtifactCount, failedArtifactCount, retentionDays }
}
