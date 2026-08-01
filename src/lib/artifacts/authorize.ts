import { and, eq, isNull } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts, users } from '@/db/schema'
import type { ManifestEntry } from '@/lib/bundle/validate'

/**
 * The read gate the artifact origin re-runs on every request (grill-result §4.2 step 5), which
 * is what makes revocation of the entry document instant.
 *
 * S3 authorizes the owner and nobody else — org visibility and share tokens become further
 * viewer kinds in S4/S5. The `viewerRef` string is the seam: it already distinguishes the kind
 * of viewer, so those slices add cases rather than changing every caller.
 *
 * S8 adds the `apiToken` kind (§5.1). It resolves to the token's owning user and gets no extra
 * reach: an API token sees exactly what its owner's session would see.
 */

const USER_VIEWER_PREFIX = 'user:'
const API_TOKEN_VIEWER_PREFIX = 'apiToken:'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function userIdWithPrefix(viewerRef: string, prefix: string): string | null {
  if (!viewerRef.startsWith(prefix)) return null
  const userId = viewerRef.slice(prefix.length)
  return UUID_PATTERN.test(userId) ? userId : null
}

export function userViewerRef(userId: string): string {
  return `${USER_VIEWER_PREFIX}${userId}`
}

export function apiTokenViewerRef(userId: string): string {
  return `${API_TOKEN_VIEWER_PREFIX}${userId}`
}

/** Session viewers only — the handoff flow (§4.2) issues no ref for an API token. */
export function userIdFromViewerRef(viewerRef: string): string | null {
  return userIdWithPrefix(viewerRef, USER_VIEWER_PREFIX)
}

/** The user a read is authorized as, for either viewer kind. */
export function viewerUserIdFromRef(viewerRef: string): string | null {
  return (
    userIdFromViewerRef(viewerRef) ?? userIdWithPrefix(viewerRef, API_TOKEN_VIEWER_PREFIX)
  )
}

export interface AuthorizedVersion {
  readonly artifactId: string
  readonly versionId: string
  readonly entryPath: string
  readonly manifest: readonly ManifestEntry[]
}

/**
 * `null` means "no readable artifact", never "exists but forbidden": the artifact id is part of
 * a public hostname, so distinguishing the two would confirm an artifact exists to anyone who
 * can guess a UUID.
 */
export async function authorizeArtifactRead(
  artifactId: string,
  viewerRef: string,
): Promise<AuthorizedVersion | null> {
  const userId = viewerUserIdFromRef(viewerRef)
  if (userId === null || !UUID_PATTERN.test(artifactId)) return null

  const [row] = await db
    .select({
      versionId: artifactVersions.id,
      entryPath: artifactVersions.entryPath,
      manifest: artifactVersions.manifest,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .innerJoin(users, eq(users.id, artifacts.ownerId))
    .where(
      and(
        eq(artifacts.id, artifactId),
        isNull(artifacts.deletedAt),
        eq(artifacts.ownerId, userId),
        // A deactivated owner loses their own reads on the next request (§7).
        eq(users.isActive, true),
        eq(artifactVersions.status, 'ready'),
      ),
    )
    .limit(1)

  if (row === undefined) return null
  return { artifactId, versionId: row.versionId, entryPath: row.entryPath, manifest: row.manifest }
}

/**
 * Exact match, no normalisation and no prefix matching (§4.2 step 6). A path the manifest does
 * not list is refused here, before any storage call is made.
 */
export function resolveManifestPath(
  manifest: readonly ManifestEntry[],
  path: string,
): ManifestEntry | null {
  return manifest.find((entry) => entry.path === path) ?? null
}
