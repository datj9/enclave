import { and, asc, eq, exists, isNotNull, isNull, not, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { artifactCategories } from '@/db/schema/categories'
import { classifyArtifactVersion } from '@/lib/categories/classify'
import { ENTRY_PATH } from '@/lib/bundle/validate'
import { getAutoCategorizeEnabled } from '@/lib/settings/instance-settings'
import { storageKey, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * One-shot operator job for artifacts that existed before auto-categorize was turned on.
 *
 * Only live, model-sourced artifacts with no tag rows are eligible. A manual tag set, a
 * trashed artifact, or a row the live classifier already filled in is left alone. The
 * classifier itself still no-ops when the setting is off, no instance key is configured, or
 * the taxonomy is empty — this job does not bypass those gates.
 *
 *   pnpm exec tsx scripts/classify-backfill.ts
 */

export interface ClassifyBackfillResult {
  readonly eligibleCount: number
  readonly classifiedCount: number
  readonly skippedCount: number
}

export interface ClassifyBackfillOptions {
  /** When set, only this owner's artifacts are considered. The operator script leaves it unset. */
  readonly ownerId?: string
}

function untaggedModelArtifacts(options: ClassifyBackfillOptions) {
  return db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      currentVersionId: artifacts.currentVersionId,
    })
    .from(artifacts)
    .where(
      and(
        isNull(artifacts.deletedAt),
        eq(artifacts.categorySource, 'model'),
        isNotNull(artifacts.currentVersionId),
        options.ownerId === undefined ? undefined : eq(artifacts.ownerId, options.ownerId),
        not(
          exists(
            db
              .select({ one: sql`1` })
              .from(artifactCategories)
              .where(eq(artifactCategories.artifactId, artifacts.id)),
          ),
        ),
      ),
    )
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
}

export async function backfillArtifactCategories(
  store: ObjectStore = objectStore(),
  options: ClassifyBackfillOptions = {},
): Promise<ClassifyBackfillResult> {
  const eligible = await untaggedModelArtifacts(options)

  if (!(await getAutoCategorizeEnabled())) {
    return { eligibleCount: eligible.length, classifiedCount: 0, skippedCount: 0 }
  }

  let classifiedCount = 0
  let skippedCount = 0

  for (const artifact of eligible) {
    const versionId = artifact.currentVersionId
    if (versionId === null) {
      skippedCount += 1
      continue
    }

    const entry = await store.getObject(storageKey(artifact.id, versionId, ENTRY_PATH))
    if (entry === undefined) {
      skippedCount += 1
      console.warn(`[enclave] backfill skipped artifact ${artifact.id} — missing ${ENTRY_PATH}`)
      continue
    }

    await classifyArtifactVersion({
      artifactId: artifact.id,
      title: artifact.title,
      files: [{ path: ENTRY_PATH, content: entry.body }],
    })
    classifiedCount += 1
  }

  return { eligibleCount: eligible.length, classifiedCount, skippedCount }
}
