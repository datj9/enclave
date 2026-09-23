import { and, eq, isNull, lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { PENDING_SWEEP_AFTER_MINUTES } from '@/lib/artifacts/pending'
import { versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * Reclaims versions stuck in `pending` — a write that died between "insert the row" and "flip to
 * ready" (decision #21, US-2 AC4).
 *
 * A version-less, non-current, non-trashed artifact is the same failure one layer up — its title
 * and slug are prompt-derived text with no version left to justify keeping the row (§8 data
 * retention). The parent delete is folded into the same transaction as the version delete so
 * nothing else can observe the artifact in that in-between state.
 *
 * Each version is claimed before anything is deleted: one transaction locks its row
 * (`FOR UPDATE SKIP LOCKED`), re-checks that it is still `pending` and still past the cutoff,
 * deletes its objects, deletes the row, and commits. `markVersionReady` flips the version with a
 * guarded `UPDATE … WHERE status = 'pending'` that takes the same row lock, and only then locks
 * the artifact — the same version-then-artifact order as here, so the two cannot deadlock. Of the
 * two interleavings:
 *
 * - The flip locks the row first: the claim skips the locked row (or, once the flip commits,
 *   no longer sees it as pending) and touches neither the objects nor the row. The upload keeps
 *   every file.
 * - The claim locks the row first: the flip blocks on it until the sweep commits, then finds no
 *   row, updates nothing, and throws before repointing — the upload fails instead of serving a
 *   bundle whose objects are gone.
 *
 * What the lock cannot cover is an upload still *putting* objects when its row is swept: those
 * puts land after `deletePrefix` under a prefix no row names. That needs an upload to outlast the
 * cutoff and is left to storage lifecycle rules.
 *
 * A storage failure rolls the claim back, leaving the row for the next run to retry — never a
 * row pointing at a half-deleted prefix.
 *
 * Run it on a schedule, once a minute is plenty:
 *   * * * * * cd /app && pnpm exec tsx scripts/sweep-pending.ts
 */

export { PENDING_SWEEP_AFTER_MINUTES }

export interface SweepResult {
  readonly sweptVersionCount: number
  readonly failedVersionCount: number
  readonly sweptArtifactCount: number
}

type Sweep = 'skipped' | 'version' | 'version-and-artifact'

/** Postgres `now()`, never app-server time (§7 clock skew). */
const isStale = lt(
  artifactVersions.createdAt,
  sql`now() - make_interval(mins => ${PENDING_SWEEP_AFTER_MINUTES})`,
)

async function sweepVersion(
  store: ObjectStore,
  version: { readonly id: string; readonly artifactId: string },
): Promise<Sweep> {
  return await db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(
        and(eq(artifactVersions.id, version.id), eq(artifactVersions.status, 'pending'), isStale),
      )
      .for('update', { skipLocked: true })

    // Flipped to ready since the scan, mid-flip right now, gone, or claimed by another sweep.
    if (claimed === undefined) return 'skipped'

    await store.deletePrefix(versionPrefix(version.artifactId, version.id))
    await transaction.delete(artifactVersions).where(eq(artifactVersions.id, version.id))

    // Locked before the "any versions left" check, so an `appendVersion` that holds the artifact
    // is waited out and its freshly committed version is seen, rather than cascaded away.
    await transaction
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.id, version.artifactId))
      .for('update')

    const [remainingVersion] = await transaction
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, version.artifactId))
      .limit(1)

    if (remainingVersion !== undefined) return 'version'

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

    return deletedArtifact.length > 0 ? 'version-and-artifact' : 'version'
  })
}

export async function sweepPendingVersions(
  store: ObjectStore = objectStore(),
): Promise<SweepResult> {
  const stale = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.status, 'pending'), isStale))

  let sweptVersionCount = 0
  let failedVersionCount = 0
  let sweptArtifactCount = 0

  for (const version of stale) {
    try {
      const swept = await sweepVersion(store, version)
      if (swept === 'skipped') continue

      sweptVersionCount += 1
      if (swept === 'version-and-artifact') sweptArtifactCount += 1
    } catch (error) {
      failedVersionCount += 1
      const reason = error instanceof Error ? error.name : 'unknown error'
      console.error(`[enclave] sweep skipped version ${version.id} — ${reason}, will retry`)
    }
  }

  return { sweptVersionCount, failedVersionCount, sweptArtifactCount }
}
