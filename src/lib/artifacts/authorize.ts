import { and, eq } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts, type Visibility } from '@/db/schema'
import { users } from '@/db/schema/users'
import type { ManifestEntry } from '@/lib/bundle/validate'
import { canRead, type Viewer } from './can-read'

/**
 * The read gate the artifact origin re-runs on every request (grill-result §4.2 step 5), which
 * is what makes revocation of the entry document instant.
 *
 * This module loads the rows; `can-read.ts` makes the decision. §5.1 is implemented there and
 * nowhere else — adding a viewer kind or a visibility level means editing `canRead`, not any of
 * the callers below.
 *
 * The `viewerRef` string is the wire form of a `Viewer`: it survives a round trip through the
 * handoff token and the grant cookie, where a structured viewer could not.
 */

const USER_VIEWER_PREFIX = 'user:'
const API_TOKEN_VIEWER_PREFIX = 'apiToken:'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export { canRead }
export type { ReadableArtifact, ReadableVersion, Viewer } from './can-read'

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
  return userIdFromViewerRef(viewerRef) ?? userIdWithPrefix(viewerRef, API_TOKEN_VIEWER_PREFIX)
}

export interface AuthorizedVersion {
  readonly artifactId: string
  readonly versionId: string
  readonly entryPath: string
  readonly manifest: readonly ManifestEntry[]
  readonly visibility: Visibility
  readonly isOwner: boolean
}

/**
 * Re-read on every request rather than trusted from the ref, so deactivating a user revokes
 * their reads — and their tokens' reads — on the next one (§7).
 */
export async function resolveViewer(viewerRef: string): Promise<Viewer | null> {
  const userId = viewerUserIdFromRef(viewerRef)
  if (userId === null) return null

  const [user] = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isActive, true)))
    .limit(1)

  if (user === undefined) return null

  return viewerRef.startsWith(API_TOKEN_VIEWER_PREFIX)
    ? { kind: 'apiToken', userId }
    : { kind: 'user', id: userId, role: user.role, isActive: user.isActive }
}

interface ArtifactWithCurrentVersion {
  readonly artifact: {
    readonly id: string
    readonly ownerId: string
    readonly visibility: Visibility
    readonly deletedAt: Date | null
  }
  readonly version: {
    readonly id: string
    readonly artifactId: string
    readonly entryPath: string
    readonly manifest: readonly ManifestEntry[]
  }
}

/**
 * No visibility or deletion predicate here on purpose: those are `canRead`'s branches 1 and 3,
 * and duplicating them in SQL would give the gate a second, silently diverging implementation.
 * `status = 'ready'` is not an authorization rule — a half-written version has nothing to serve.
 */
export async function loadArtifactForRead(
  artifactId: string,
): Promise<ArtifactWithCurrentVersion | null> {
  if (!UUID_PATTERN.test(artifactId)) return null

  const [row] = await db
    .select({
      ownerId: artifacts.ownerId,
      visibility: artifacts.visibility,
      deletedAt: artifacts.deletedAt,
      versionId: artifactVersions.id,
      versionArtifactId: artifactVersions.artifactId,
      entryPath: artifactVersions.entryPath,
      manifest: artifactVersions.manifest,
    })
    .from(artifacts)
    .innerJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
    .where(and(eq(artifacts.id, artifactId), eq(artifactVersions.status, 'ready')))
    .limit(1)

  if (row === undefined) return null

  return {
    artifact: {
      id: artifactId,
      ownerId: row.ownerId,
      visibility: row.visibility,
      deletedAt: row.deletedAt,
    },
    version: {
      id: row.versionId,
      artifactId: row.versionArtifactId,
      entryPath: row.entryPath,
      manifest: row.manifest,
    },
  }
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
  const viewer = await resolveViewer(viewerRef)
  if (viewer === null) return null

  const loaded = await loadArtifactForRead(artifactId)
  if (loaded === null) return null
  if (!canRead(viewer, loaded.artifact, loaded.version)) return null

  return {
    artifactId,
    versionId: loaded.version.id,
    entryPath: loaded.version.entryPath,
    manifest: loaded.version.manifest,
    visibility: loaded.artifact.visibility,
    isOwner: loaded.artifact.ownerId === viewerUserIdFromRef(viewerRef),
  }
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
