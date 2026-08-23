import { and, asc, eq, exists, isNotNull, isNull, not, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { artifactCategories } from '@/db/schema/categories'
import { classifyArtifactVersion } from '@/lib/categories/classify'
import { ENTRY_PATH } from '@/lib/bundle/validate'
import { getAutoCategorizeEnabled } from '@/lib/settings/instance-settings'
import { storageKey, type FetchedObject, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * One-shot operator job for artifacts that existed before auto-categorize was turned on.
 *
 * Only live, model-sourced artifacts with no tag rows are eligible. A manual tag set, a
 * trashed artifact, or a row the live classifier already filled in is left alone. The
 * classifier itself still no-ops when the setting is off, no instance key is configured, or
 * the taxonomy is empty — this job does not bypass those gates.
 *
 *   pnpm exec tsx scripts/classify-backfill.ts [--limit <n>] [--owner <userId>] [--dry-run]
 */

export interface ClassifyBackfillResult {
  readonly eligibleCount: number
  /** Artifacts whose tags the classifier actually wrote, never the number of attempts. */
  readonly classifiedCount: number
  /** Eligible artifacts that ended the run untagged, whether or not the provider was called. */
  readonly skippedCount: number
}

export interface ClassifyBackfillOptions {
  /** When set, only this owner's artifacts are considered. The operator script leaves it unset. */
  readonly ownerId?: string | undefined
  /** Caps the run, so a first pass can be sized before paying for every eligible artifact. */
  readonly limit?: number | undefined
  /** Reports what would be classified and returns before the first provider call. */
  readonly isDryRun?: boolean | undefined
}

interface EligibleArtifact {
  readonly id: string
  readonly title: string
  readonly currentVersionId: string | null
}

async function untaggedModelArtifacts(
  options: ClassifyBackfillOptions,
): Promise<readonly EligibleArtifact[]> {
  const query = db
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

  if (options.limit === undefined) return await query
  return await query.limit(options.limit)
}

/** A transient storage fault on one row must not end the run: every later row would be lost. */
async function readEntryObject(
  store: ObjectStore,
  artifact: EligibleArtifact,
): Promise<FetchedObject | undefined> {
  if (artifact.currentVersionId === null) return undefined

  const key = storageKey(artifact.id, artifact.currentVersionId, ENTRY_PATH)
  try {
    const entry = await store.getObject(key)
    if (entry === undefined) {
      console.warn(`[enclave] backfill skipped artifact ${artifact.id} - missing ${ENTRY_PATH}`)
    }
    return entry
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error'
    console.error(
      `[enclave] backfill skipped artifact ${artifact.id} - could not read ${ENTRY_PATH} (${reason})`,
    )
    return undefined
  }
}

export async function backfillArtifactCategories(
  store: ObjectStore = objectStore(),
  options: ClassifyBackfillOptions = {},
): Promise<ClassifyBackfillResult> {
  const eligible = await untaggedModelArtifacts(options)

  // Gated after the query on purpose: a run with the setting off still reports what is eligible.
  if (!(await getAutoCategorizeEnabled())) {
    return { eligibleCount: eligible.length, classifiedCount: 0, skippedCount: 0 }
  }

  if (options.isDryRun === true) {
    for (const artifact of eligible) {
      console.info(`[enclave] backfill would classify artifact ${artifact.id} (${artifact.title})`)
    }
    return { eligibleCount: eligible.length, classifiedCount: 0, skippedCount: 0 }
  }

  let classifiedCount = 0
  let skippedCount = 0

  for (const artifact of eligible) {
    const entry = await readEntryObject(store, artifact)
    if (entry === undefined) {
      skippedCount += 1
      continue
    }

    const wasClassified = await classifyArtifactVersion({
      artifactId: artifact.id,
      title: artifact.title,
      files: [{ path: ENTRY_PATH, content: entry.body }],
    })

    if (wasClassified) classifiedCount += 1
    else skippedCount += 1
  }

  return { eligibleCount: eligible.length, classifiedCount, skippedCount }
}
