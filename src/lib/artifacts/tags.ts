import { and, asc, eq, inArray } from 'drizzle-orm'

import { db } from '@/db'
import { artifactCategories, categories } from '@/db/schema/categories'
import { artifacts } from '@/db/schema/artifacts'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { type CategoryView } from '@/lib/categories/manage'
import type { DbHandle } from '@/lib/invites/redeem'

import {
  requireOwnedArtifact,
  updateArtifact,
  type ArtifactView,
  type UpdateArtifactInput,
} from './update'

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

/**
 * The row half of a manual replacement, on the caller's handle so it can share a transaction with
 * other writes. The caller must be inside a transaction: the delete and insert are only atomic
 * together there.
 */
async function writeManualTags(
  handle: DbHandle,
  artifactId: string,
  ids: readonly string[],
): Promise<void> {
  await handle.delete(artifactCategories).where(eq(artifactCategories.artifactId, artifactId))

  if (ids.length > 0) {
    await handle
      .insert(artifactCategories)
      .values(ids.map((categoryId) => ({ artifactId, categoryId })))
  }

  await handle
    .update(artifacts)
    .set({ categorySource: 'manual', updatedAt: new Date() })
    .where(eq(artifacts.id, artifactId))
}

function recordManualTagChange(input: {
  readonly ownerId: string
  readonly artifactId: string
  readonly ids: readonly string[]
  readonly actorIp?: string | null
}): Promise<void> {
  return recordAuditEvent({
    action: 'artifact.tag_change',
    actorUserId: input.ownerId,
    actorIp: input.actorIp ?? null,
    artifactId: input.artifactId,
    metadata: { categoryIds: [...input.ids], categorySource: 'manual' },
  })
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

  await db.transaction((transaction) => writeManualTags(transaction, input.artifactId, ids))

  await recordManualTagChange({
    ownerId: owned.ownerId,
    artifactId: input.artifactId,
    ids,
    actorIp: input.actorIp ?? null,
  })

  return (await readArtifactTags([input.artifactId])).get(input.artifactId) ?? []
}

export interface UpdatedArtifactWithTags {
  readonly artifact: ArtifactView
  readonly categories: readonly CategoryView[]
  /** Whether `categoryIds` was part of the patch, i.e. whether the tag set was replaced. */
  readonly tagsReplaced: boolean
}

/**
 * The whole `PATCH /api/v1/artifacts/{id}`: title, visibility and the tag set commit in one
 * transaction, so a PATCH that renames and re-tags can never land half-applied if the tag write
 * fails. `categoryIds` must already have passed `assertCategoriesAvailable` — the route checks it
 * before any write so a bad id is a 422 that changed nothing.
 */
export async function updateArtifactWithTags(
  input: Omit<UpdateArtifactInput, 'alsoWrite'>,
): Promise<UpdatedArtifactWithTags> {
  const categoryIds = input.patch.categoryIds
  if (categoryIds === undefined) {
    const artifact = await updateArtifact(input)
    const categories = (await readArtifactTags([artifact.id])).get(artifact.id) ?? []
    return { artifact, categories, tagsReplaced: false }
  }

  const ids = [...new Set(categoryIds)]
  let ownerId: string | undefined
  const artifact = await updateArtifact({
    ...input,
    alsoWrite: async (handle, owner) => {
      ownerId = owner.ownerId
      await writeManualTags(handle, input.artifactId, ids)
    },
  })

  if (ownerId !== undefined) {
    await recordManualTagChange({
      ownerId,
      artifactId: input.artifactId,
      ids,
      actorIp: input.actorIp ?? null,
    })
  }

  const categories = (await readArtifactTags([artifact.id])).get(artifact.id) ?? []
  return { artifact, categories, tagsReplaced: true }
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
 *
 * Returns whether the write happened, so a caller can report classifications rather than attempts.
 */
export async function applyModelTags(
  artifactId: string,
  categoryIds: readonly string[],
): Promise<boolean> {
  const ids = [...new Set(categoryIds)]

  const wasWritten = await db.transaction(async (transaction) => {
    // Guarded source update first: only a row still sourced from the model may be re-tagged, so a
    // manual tag set (or an owner flipping the source mid-flight) is never silently overwritten.
    const updated = await transaction
      .update(artifacts)
      .set({ categorySource: 'model', updatedAt: new Date() })
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.categorySource, 'model')))
      .returning({ id: artifacts.id })

    if (updated.length === 0) return false

    await transaction.delete(artifactCategories).where(eq(artifactCategories.artifactId, artifactId))

    if (ids.length > 0) {
      await transaction.insert(artifactCategories).values(
        ids.map((categoryId) => ({ artifactId, categoryId })),
      )
    }

    return true
  })

  if (!wasWritten) return false

  // No actor: the server classified this, not a user.
  await recordAuditEvent({
    action: 'artifact.auto_tag',
    artifactId,
    metadata: { categoryIds: ids, categorySource: 'model' },
  })

  return true
}
