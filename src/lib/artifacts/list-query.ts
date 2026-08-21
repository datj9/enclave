/**
 * `GET /api/v1/artifacts?cursor=&limit=` parsing, per the S2 contract. Pure, so the boundary
 * cases (limit 0, limit 101, a tampered cursor) are unit-testable without a database.
 *
 * The cursor is an opaque keyset position, not an offset: an artifact created while the caller
 * pages cannot shift rows onto a page they already read.
 */

export const DEFAULT_LIST_LIMIT = 20
export const MAX_LIST_LIMIT = 100

export interface ListCursor {
  readonly createdAt: string
  readonly id: string
}

export interface ListQuery {
  readonly limit: number
  readonly cursor: ListCursor | undefined
  readonly categorySlug?: string
}

export type ListQueryParse =
  | { readonly ok: true; readonly value: ListQuery }
  | { readonly ok: false; readonly details: Record<string, unknown> }

const CURSOR_SEPARATOR = '|'

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(`${cursor.createdAt}${CURSOR_SEPARATOR}${cursor.id}`, 'utf8').toString(
    'base64url',
  )
}

export function decodeListCursor(raw: string): ListCursor | undefined {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR)
  if (separatorIndex === -1) return undefined

  const createdAt = decoded.slice(0, separatorIndex)
  const id = decoded.slice(separatorIndex + 1)
  if (id === '') return undefined
  if (Number.isNaN(Date.parse(createdAt))) return undefined

  return { createdAt, id }
}

function parseLimit(raw: string | null): number | undefined {
  if (raw === null || raw === '') return DEFAULT_LIST_LIMIT
  if (!/^\d+$/.test(raw)) return undefined

  const limit = Number(raw)
  if (limit < 1 || limit > MAX_LIST_LIMIT) return undefined
  return limit
}

function parseCategorySlug(raw: string | null): string | undefined {
  if (raw === null) return undefined

  const slug = raw.trim()
  if (slug === '') return undefined
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return undefined
  return slug
}

export function parseListQuery(searchParams: URLSearchParams): ListQueryParse {
  const limit = parseLimit(searchParams.get('limit'))
  if (limit === undefined) {
    return { ok: false, details: { parameter: 'limit', max: MAX_LIST_LIMIT } }
  }

  const categorySlug = parseCategorySlug(searchParams.get('category'))
  if (categorySlug === undefined && (searchParams.get('category') ?? '').trim() !== '') {
    return { ok: false, details: { parameter: 'category', fields: ['category'] } }
  }

  const rawCursor = searchParams.get('cursor')
  if (rawCursor === null || rawCursor === '') {
    return { ok: true, value: { limit, cursor: undefined, ...(categorySlug === undefined ? {} : { categorySlug }) } }
  }

  const cursor = decodeListCursor(rawCursor)
  if (cursor === undefined) return { ok: false, details: { parameter: 'cursor' } }

  return { ok: true, value: { limit, cursor, ...(categorySlug === undefined ? {} : { categorySlug }) } }
}
