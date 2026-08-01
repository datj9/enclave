import { eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { shareLinks } from '@/db/schema/share-links'
import type { ShareLinkBinding } from '@/lib/artifacts/can-read'
import { hashShareToken, isShareTokenShaped } from './token'

/**
 * Reading a share link, and nothing else — `manage.ts` owns creation and revocation.
 *
 * The split exists because `authorize.ts` imports this module to resolve a share-token viewer,
 * while `manage.ts` imports `authorize.ts` for the owner check. Keeping the reads here is what
 * stops that from being a cycle.
 *
 * Every read returns the row **unfiltered** together with the database's own clock. `canRead`
 * branch 4 decides whether the link is still good; filtering revoked or expired rows out in SQL
 * would give the §5.1 gate a second implementation that could silently diverge from it. Carrying
 * `databaseNow` is what keeps the expiry comparison on Postgres time (§7 clock skew).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface ResolvedShareLink {
  readonly shareLinkId: string
  readonly link: ShareLinkBinding
  readonly databaseNow: Date
}

const LINK_COLUMNS = {
  id: shareLinks.id,
  artifactId: shareLinks.artifactId,
  versionId: shareLinks.versionId,
  revokedAt: shareLinks.revokedAt,
  expiresAt: shareLinks.expiresAt,
  databaseNow: sql<Date>`now()`,
}

type LinkRow = {
  readonly id: string
  readonly artifactId: string
  readonly versionId: string
  readonly revokedAt: Date | null
  readonly expiresAt: Date | null
  readonly databaseNow: Date
}

function toResolvedShareLink(row: LinkRow): ResolvedShareLink {
  return {
    shareLinkId: row.id,
    link: {
      artifactId: row.artifactId,
      versionId: row.versionId,
      revokedAt: row.revokedAt,
      expiresAt: row.expiresAt,
    },
    databaseNow: row.databaseNow,
  }
}

/** The `/s/{token}` lookup. Only the digest reaches the query, so the plaintext stays in memory. */
export async function resolveShareLinkByToken(plaintext: string): Promise<ResolvedShareLink | null> {
  if (!isShareTokenShaped(plaintext)) return null

  const [row] = await db
    .select(LINK_COLUMNS)
    .from(shareLinks)
    .where(eq(shareLinks.tokenHash, hashShareToken(plaintext)))
    .limit(1)

  return row === undefined ? null : toResolvedShareLink(row)
}

/**
 * Re-read on every request behind a `share:` viewer ref, which is what makes revocation take
 * effect on the next document load rather than whenever the grant cookie happens to expire.
 */
export async function loadShareLink(shareLinkId: string): Promise<ResolvedShareLink | null> {
  // A share id reaches this from a URL path, where anything at all can appear; `uuid` would
  // reject a non-UUID as a 500 rather than the 404 every other rejection collapses to.
  if (!UUID_PATTERN.test(shareLinkId)) return null

  const [row] = await db
    .select(LINK_COLUMNS)
    .from(shareLinks)
    .where(eq(shareLinks.id, shareLinkId))
    .limit(1)

  return row === undefined ? null : toResolvedShareLink(row)
}

/**
 * One anonymous view. Incremented in SQL rather than read-modify-write so two viewers arriving at
 * once cannot lose a count, and `last_viewed_at` uses Postgres time like every other timestamp.
 */
export async function recordShareLinkView(shareLinkId: string): Promise<void> {
  await db
    .update(shareLinks)
    .set({ viewCount: sql`${shareLinks.viewCount} + 1`, lastViewedAt: sql`now()` })
    .where(eq(shareLinks.id, shareLinkId))
}
