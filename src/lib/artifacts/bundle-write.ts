import { eq } from 'drizzle-orm'

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

export async function markVersionReady(version: PendingVersion): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction
      .update(artifactVersions)
      .set({ status: 'ready' })
      .where(eq(artifactVersions.id, version.versionId))

    await transaction
      .update(artifacts)
      .set({ currentVersionId: version.versionId, updatedAt: new Date() })
      .where(eq(artifacts.id, version.artifactId))
  })
}
