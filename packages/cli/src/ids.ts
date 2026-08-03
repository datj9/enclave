import type { ApiClient } from './api-client.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIN_PREFIX_LENGTH = 8
const MAX_PAGES = 100

export class IdResolutionError extends Error {}

export interface ArtifactSummary {
  readonly id: string
  readonly title: string
  readonly visibility: 'private' | 'org'
  readonly viewUrl: string
}

interface ArtifactPage {
  readonly items: readonly ArtifactSummary[]
  readonly nextCursor: string | null
}

/** The first 8 hex characters of a v4 uuid; short enough to type, long enough to be unique here. */
export function shortId(id: string): string {
  return id.slice(0, MIN_PREFIX_LENGTH)
}

/**
 * A full uuid is used as-is. A prefix is matched against the caller's own artifacts, walking every
 * page — matching only the first page would make resolution depend on how much you had published.
 */
export async function resolveArtifactId(client: ApiClient, given: string): Promise<string> {
  if (UUID_PATTERN.test(given)) return given.toLowerCase()

  if (given.length < MIN_PREFIX_LENGTH) {
    throw new IdResolutionError(
      `'${given}' is too short — give at least ${String(MIN_PREFIX_LENGTH)} characters of the id`,
    )
  }

  const lowered = given.toLowerCase()
  const matches: ArtifactSummary[] = []
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  let pages = 0

  for (;;) {
    const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
    const page: ArtifactPage = await client.get<ArtifactPage>(`/api/v1/artifacts${query}`)
    for (const item of page.items) {
      if (item.id.toLowerCase().startsWith(lowered)) matches.push(item)
    }
    pages += 1
    if (page.nextCursor === null || page.nextCursor === undefined) break
    if (pages >= MAX_PAGES || seenCursors.has(page.nextCursor)) {
      throw new IdResolutionError('artifact list did not terminate — the server cursor may be stuck')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  const [only] = matches
  if (only === undefined) throw new IdResolutionError(`no artifact starts with '${given}'`)
  if (matches.length > 1) {
    const listed = matches.map((item) => `  ${shortId(item.id)}  ${item.title}`).join('\n')
    throw new IdResolutionError(
      `'${given}' matches ${String(matches.length)} artifacts:\n${listed}`,
    )
  }
  return only.id
}
