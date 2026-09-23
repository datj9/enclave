import { and, eq, isNull, or, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import type { BundleFile, ManifestEntry } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'
import { storageKey, type ObjectStore } from '@/lib/storage/object-store'

/**
 * The two reusable halves of the write path shared by the create flow and the append-version
 * flow: upload every object under a `pending` version, then flip it to `ready` and only then
 * point `current_version_id` at it. Moved out of `create.ts` verbatim so both callers stay
 * byte-identical.
 */

export interface PendingVersion {
  readonly artifactId: string
  readonly versionId: string
}

export function totalBytesOf(manifest: readonly ManifestEntry[]): number {
  return manifest.reduce((runningTotal, entry) => runningTotal + entry.bytes, 0)
}

/**
 * Sequential on purpose: a partial upload must leave a deterministic prefix behind so a retry or
 * the sweeper cleans up the same set of keys, and 50 parallel PUTs would only starve the pool.
 */
export async function uploadBundleObjects(
  store: ObjectStore,
  version: PendingVersion,
  files: readonly BundleFile[],
  manifest: readonly ManifestEntry[],
): Promise<void> {
  for (const [index, file] of files.entries()) {
    const entry = manifest[index]
    if (entry === undefined) throw new HttpError('INTERNAL_ERROR', 'Manifest is out of step')

    await store.putObject({
      key: storageKey(version.artifactId, version.versionId, file.path),
      body: file.content,
      contentType: entry.content_type,
    })
  }
}

/**
 * The `version_no` of the version `artifacts.current_version_id` points at (NULL when it points
 * nowhere), as a correlated scalar subquery for any statement over `artifacts`.
 *
 * Aliased and fully qualified by hand: drizzle drops the table prefix from columns in a
 * single-table statement, and an unqualified `"id"` inside the subquery would then rely on SQL
 * scoping rules to mean `artifact_versions.id` rather than `artifacts.id`.
 */
export const currentVersionNoOf = sql<number | null>`(select "cv"."version_no" from ${artifactVersions} as "cv" where "cv"."id" = ${artifacts}."current_version_id")`

export interface MarkedReady {
  /** False when a newer version was already current — this one is ready but not served. */
  readonly becameCurrent: boolean
}

/**
 * Flips a `pending` version to `ready`, then points `current_version_id` at it — but only when it
 * is newer than whatever is current. Two appends can finish uploading out of order (v3's bundle
 * is small, v2's is large); an unconditional flip would let v2 land last and silently roll the
 * artifact back. The artifact row is locked before the repoint so two flips for one artifact
 * serialize and the "is it newer" comparison reads a settled value.
 *
 * Lock order is version row, then artifact row — the same order as the pending sweeper, which
 * deletes the version and then (for a first version) the artifact. Taking the artifact first
 * would let the two deadlock over a slow first upload, and Postgres could then abort the sweeper
 * and let this flip serve a bundle whose objects the sweeper had already deleted.
 *
 * The status update is guarded on `status = 'pending'` and its row count asserted: flipping a
 * version that is already ready (a double call) or gone (reclaimed by the sweeper mid-upload) is
 * a bug in the caller, and pointing the artifact at it anyway would serve a half-deleted bundle.
 */
export async function markVersionReady(version: PendingVersion): Promise<MarkedReady> {
  return await db.transaction(async (transaction) => {
    const flipped = await transaction
      .update(artifactVersions)
      .set({ status: 'ready' })
      .where(
        and(
          eq(artifactVersions.id, version.versionId),
          eq(artifactVersions.artifactId, version.artifactId),
          eq(artifactVersions.status, 'pending'),
        ),
      )
      .returning({ versionNo: artifactVersions.versionNo })

    const [ready] = flipped
    if (flipped.length !== 1 || ready === undefined) {
      throw new HttpError('INTERNAL_ERROR', 'The version is no longer pending and cannot be made ready')
    }

    const [artifact] = await transaction
      .select({ currentVersionId: artifacts.currentVersionId })
      .from(artifacts)
      .where(eq(artifacts.id, version.artifactId))
      .for('update')

    if (artifact === undefined) {
      throw new HttpError('INTERNAL_ERROR', 'The artifact disappeared before its version was ready')
    }

    // Compared in SQL against the current version's number, so a NULL pointer (first version) and
    // a pointer to an older version both flip, and a pointer to a newer one never does.
    const repointed = await transaction
      .update(artifacts)
      .set({ currentVersionId: version.versionId, updatedAt: new Date() })
      .where(
        and(
          eq(artifacts.id, version.artifactId),
          or(
            isNull(artifacts.currentVersionId),
            sql`${currentVersionNoOf} < ${ready.versionNo}`,
          ),
        ),
      )
      .returning({ id: artifacts.id })

    return { becameCurrent: repointed.length === 1 }
  })
}
