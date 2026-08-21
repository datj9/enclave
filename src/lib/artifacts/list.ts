import { and, desc, eq, exists, isNull, lt, or, sql, type SQL } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts, type Visibility } from '@/db/schema/artifacts'
import { artifactCategories, categories } from '@/db/schema/categories'
import { encodeListCursor, type ListCursor, type ListQuery } from './list-query'
import { artifactViewUrl } from './naming'
import { readArtifactTags } from './tags'

/**
 * The owner's artifact list. S2 is owner-only reads by design — org visibility and `canRead`
 * arrive in S4, and this query gets replaced by that gate rather than extended here.
 *
 * The inner join on `current_version_id` is what keeps `pending` versions out of the list: the
 * column is only ever set once a version has flipped to `ready`.
 */

export interface ArtifactListItem {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly visibility: Visibility
  readonly versionId: string
  readonly versionNo: number
  readonly fileCount: number
  readonly totalBytes: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly viewUrl: string
  /** Active tags only — a deactivated category disappears from here. */
  readonly categories: readonly { readonly slug: string }[]
}

export interface ArtifactListPage {
  readonly items: readonly ArtifactListItem[]
  readonly nextCursor: string | null
}

/** List input as accepted by callers that paginate without a category filter. */
export type ArtifactListQuery = Omit<ListQuery, 'categorySlug'> & {
  readonly categorySlug?: string | undefined
}

/** Keyset predicate matching the `(created_at desc, id desc)` order exactly. */
function afterCursor(cursor: ListCursor): SQL | undefined {
  const createdAt = new Date(cursor.createdAt)
  return or(
    lt(artifacts.createdAt, createdAt),
    and(eq(artifacts.createdAt, createdAt), lt(artifacts.id, cursor.id)),
  )
}

/**
 * Restricts the page to artifacts tagged with the category whose slug matches, and whose
 * category is still active — an unknown or inactive slug then matches no rows at all.
 */
function categoryFilter(slug: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(artifactCategories)
      .innerJoin(categories, eq(artifactCategories.categoryId, categories.id))
      .where(
        and(
          eq(artifactCategories.artifactId, artifacts.id),
          eq(categories.slug, slug),
          eq(categories.isActive, true),
        ),
      ),
  )
}

export async function listOwnedArtifacts(
  ownerId: string,
  query: ArtifactListQuery,
): Promise<ArtifactListPage> {
  const rows = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      slug: artifacts.slug,
      visibility: artifacts.visibility,
      versionId: artifactVersions.id,
      versionNo: artifactVersions.versionNo,
      fileCount: artifactVersions.fileCount,
      totalBytes: artifactVersions.totalBytes,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(
      and(
        eq(artifacts.ownerId, ownerId),
        isNull(artifacts.deletedAt),
        eq(artifactVersions.status, 'ready'),
        query.categorySlug === undefined ? undefined : categoryFilter(query.categorySlug),
        query.cursor === undefined ? undefined : afterCursor(query.cursor),
      ),
    )
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    // One extra row answers "is there a next page" without a second count query.
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  const hasMore = rows.length > query.limit

  const tagsById = await readArtifactTags(page.map((row) => row.id))

  return {
    items: page.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      viewUrl: artifactViewUrl(row.id),
      categories: tagsById.get(row.id) ?? [],
    })),
    nextCursor:
      hasMore && last !== undefined
        ? encodeListCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  }
}
