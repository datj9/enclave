import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm'

import { db } from '@/db'
import { shareLinks } from '@/db/schema/share-links'

/**
 * How many links still open an artifact. The owner needs this number before downgrading to
 * `private`, because that downgrade closes nothing: `canRead` branch 4 judges a share-token viewer
 * on the link alone and never reads `visibility`.
 *
 * The predicate is branch 4's revoke-and-expiry half, verbatim. Branch 4 also pins `version_id`,
 * but this count is deliberately **per artifact**: a link on an older version still opens that
 * version, and the owner still has to revoke it. Scoping to the current version would read 0 the
 * moment a newer version exists and warn about nothing.
 *
 * `now()` is evaluated inside this one statement, so the clock and the count are one reading of one
 * instant — the §7 rule `clock.ts` exists for. Owner-only data, with no ownership check of its own:
 * both callers establish ownership before asking.
 */
export async function countLiveShareLinks(artifactId: string): Promise<number> {
  const [row] = await db
    .select({ liveCount: count() })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.artifactId, artifactId),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, sql`now()`)),
      ),
    )

  return row?.liveCount ?? 0
}
