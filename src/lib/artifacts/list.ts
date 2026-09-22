import { and, desc, eq, exists, isNull, lt, or, sql, type SQL } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts, type Visibility } from '@/db/schema/artifacts'
import { artifactCategories, categories } from '@/db/schema/categories'
import { HttpError } from '@/lib/http'
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `created_at` as written by `cursorTimestampOf`: ISO 8601, UTC, exactly six fractional digits. */
const MICROSECOND_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/**
 * `created_at` rendered by Postgres at its full microsecond precision. A JS `Date` holds
 * milliseconds only, so a cursor built from `toISOString()` sits up to 999µs *before* the row it
 * came from — and `created_at < cursor` then skips every row created later in that same
 * millisecond, which bulk inserts and fast CLI pushes routinely produce.
 */
const cursorTimestampOf = sql<string>`to_char(${artifacts.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

function invalidCursor(): HttpError {
  return new HttpError('VALIDATION_FAILED', 'The query parameters are not valid', {
    details: { parameter: 'cursor' },
  })
}

/**
 * Normalises the cursor's timestamp into something Postgres will cast. A current cursor is used
 * verbatim, keeping every microsecond. A cursor issued before this change (millisecond ISO, from
 * `toISOString()`) is still accepted best-effort — it pages exactly as it used to — rather than
 * breaking a client mid-pagination on deploy. Anything else is rejected as a bad cursor instead of
 * reaching the database as an uncastable literal and surfacing as a 500.
 */
export function cursorTimestamp(raw: string): string {
  if (MICROSECOND_TIMESTAMP.test(raw)) return raw

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) throw invalidCursor()
  return parsed.toISOString()
}

/** Keyset predicate matching the `(created_at desc, id desc)` order exactly. */
export function afterCursor(cursor: ListCursor): SQL | undefined {
  if (!UUID_PATTERN.test(cursor.id)) throw invalidCursor()

  const createdAt = sql`${cursorTimestamp(cursor.createdAt)}::timestamptz`
  return or(
    sql`${artifacts.createdAt} < ${createdAt}`,
    and(sql`${artifacts.createdAt} = ${createdAt}`, lt(artifacts.id, cursor.id)),
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
      cursorCreatedAt: cursorTimestampOf,
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
    // Field by field so the cursor-only `cursorCreatedAt` column never leaks into the API shape.
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      visibility: row.visibility,
      versionId: row.versionId,
      versionNo: row.versionNo,
      fileCount: row.fileCount,
      totalBytes: row.totalBytes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      viewUrl: artifactViewUrl(row.id),
      categories: tagsById.get(row.id) ?? [],
    })),
    nextCursor:
      hasMore && last !== undefined
        ? encodeListCursor({ createdAt: last.cursorCreatedAt, id: last.id })
        : null,
  }
}
