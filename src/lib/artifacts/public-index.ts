import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'

/**
 * The list behind `/sitemap.xml`: every artifact whose visibility is `public`, newest change first.
 *
 * The three predicates are the same three facts `canRead` needs to say yes to an anonymous viewer —
 * `public`, not in the trash, and a ready current version to serve. A row that fails any of them
 * would be a sitemap entry that answers with a redirect to sign-in, which is worse than absent.
 */

/** A crawler stops reading a sitemap long before this; a self-hosted instance is nowhere near. */
const MAX_SITEMAP_ENTRIES = 5000

export interface PublicArtifactEntry {
  readonly id: string
  readonly updatedAt: Date
}

export async function listPublicArtifacts(
  limit: number = MAX_SITEMAP_ENTRIES,
): Promise<readonly PublicArtifactEntry[]> {
  return await db
    .select({ id: artifacts.id, updatedAt: artifacts.updatedAt })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.visibility, 'public'),
        isNull(artifacts.deletedAt),
        isNotNull(artifacts.currentVersionId),
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(limit)
}
