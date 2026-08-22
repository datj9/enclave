import { and, asc, eq, inArray } from 'drizzle-orm'

import { db } from '@/db'
import { artifactCategories, categories } from '@/db/schema/categories'
import { artifacts } from '@/db/schema/artifacts'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { type CategoryView } from '@/lib/categories/manage'

import { requireOwnedArtifact } from './update'

/**
 * `PATCH /api/v1/artifacts/{id}` tag handling (§artifact-tagging). `categoryIds` replaces the
 * whole tag set; the source flips to `manual` so a later re-derivation never resurrects a tag the
 * author explicitly cleared. Validation is all-or-nothing and runs before any write, so a bad id
 * can never leave a half-replaced row set behind.
 */

export const MAX_TAGS_PER_ARTIFACT = 10

const CATEGORY_ERROR = (): HttpError =>
  new HttpError('VALIDATION_FAILED', 'One or more categories are not available', {
    details: { fields: ['categoryIds'] },
  })

/**
 * Every id must exist and be active before a single row is written; otherwise a partial
 * replacement would silently drop the tags the caller still believed were being set. Exported so
 * the PATCH route can validate `categoryIds` before its artifact update runs.
 */
export async function assertCategoriesAvailable(ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)]
  if (unique.length > MAX_TAGS_PER_ARTIFACT) throw CATEGORY_ERROR()
  if (unique.length === 0) return

  const found = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(inArray(categories.id, unique), eq(categories.isActive, true)))
  if (found.length !== unique.length) throw CATEGORY_ERROR()
}

export async function replaceArtifactTags(input: {
  readonly artifactId: string
  readonly categoryIds: readonly string[]
  readonly viewerRef: string
  readonly actorIp?: string | null
}): Promise<readonly CategoryView[]> {
  const owned = await requireOwnedArtifact(input.artifactId, input.viewerRef)

  await assertCategoriesAvailable(input.categoryIds)
  const ids = [...new Set(input.categoryIds)]

  await db.transaction(async (transaction) => {
    await transaction
      .delete(artifactCategories)
      .where(eq(artifactCategories.artifactId, input.artifactId))

    if (ids.length > 0) {
      await transaction.insert(artifactCategories).values(
        ids.map((categoryId) => ({ artifactId: input.artifactId, categoryId })),
      )
    }

    await transaction
      .update(artifacts)
      .set({ categorySource: 'manual', updatedAt: new Date() })
      .where(eq(artifacts.id, input.artifactId))
  })

  await recordAuditEvent({
    action: 'artifact.tag_change',
    actorUserId: owned.ownerId,
    actorIp: input.actorIp ?? null,
    artifactId: input.artifactId,
    metadata: { categoryIds: ids, categorySource: 'manual' },
  })

  return (await readArtifactTags([input.artifactId])).get(input.artifactId) ?? []
}

export async function readArtifactTags(
  artifactIds: readonly string[],
): Promise<ReadonlyMap<string, readonly CategoryView[]>> {
  const tags = new Map<string, CategoryView[]>()
  if (artifactIds.length === 0) return tags

  const rows = await db
    .select({
      artifactId: artifactCategories.artifactId,
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      isActive: categories.isActive,
      createdAt: categories.createdAt,
    })
    .from(artifactCategories)
    .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
    .where(and(inArray(artifactCategories.artifactId, artifactIds), eq(categories.isActive, true)))
    .orderBy(asc(categories.name))

  for (const row of rows) {
    const current = tags.get(row.artifactId) ?? []
    current.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
    })
    tags.set(row.artifactId, current)
  }

  return tags
}

/**
 * Model-sourced replacement of an artifact's tags: the classifier's result, not a user's. The
 * whole write is one transaction, existing rows are cleared first (even for an empty list), and
 * `category_source` is written explicitly to `'model'` so a later append re-classifies. There is
 * deliberately no ownership check — the caller is the server, never a user.
 */
export async function applyModelTags(
  artifactId: string,
  categoryIds: readonly string[],
): Promise<void> {
  await db.transaction(async (transaction) => {
    // Guarded source update first: only a row still sourced from the model may be re-tagged, so a
    // manual tag set (or an owner flipping the source mid-flight) is never silently overwritten.
    const updated = await transaction
      .update(artifacts)
      .set({ categorySource: 'model', updatedAt: new Date() })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.categorySource, 'model')))
      .returning({ id: artifacts.id })

    if (updated.length === 0) return

    await transaction.delete(artifactCategories).where(eq(artifactCategories.artifactId, artifactId))

    if (categoryIds.length > 0) {
      await transaction.insert(artifactCategories).values(
        [...new Set(categoryIds)].map((categoryId) => ({ artifactId, categoryId })),
      )
    }
  })
}
