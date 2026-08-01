import type { Visibility } from '@/db/schema/artifacts'
import type { UserRole } from '@/db/schema/users'

/**
 * grill-result §5.1, the resolution function every read path in the product runs through.
 * `authorizeArtifactRead` loads the rows and calls this; nothing else decides who may read.
 *
 * Kept pure and in its own file so every branch is reachable from a unit test — this gate is
 * held to 100% branch coverage, and a Postgres round trip in the same file would make that
 * impossible to prove.
 */

export type Viewer =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly role: UserRole
      readonly isActive: boolean
    }
  | { readonly kind: 'shareToken'; readonly shareLinkId: string }
  | { readonly kind: 'apiToken'; readonly userId: string }

export interface ReadableArtifact {
  readonly id: string
  readonly ownerId: string
  readonly visibility: Visibility
  readonly deletedAt: Date | null
}

export interface ReadableVersion {
  readonly id: string
  readonly artifactId: string
}

/** An API token reaches exactly as far as the user who minted it, and never further. */
function isOwner(viewer: Viewer, ownerId: string): boolean {
  if (viewer.kind === 'user') return viewer.id === ownerId
  if (viewer.kind === 'apiToken') return viewer.userId === ownerId
  return false
}

export function canRead(
  viewer: Viewer,
  artifact: ReadableArtifact,
  version: ReadableVersion,
): boolean {
  // Precondition rather than one of the six branches: a version belonging to another artifact is
  // a caller bug, and guessing which of the two was meant is how a gate leaks.
  if (version.artifactId !== artifact.id) return false

  // 1. Trash is unreadable to everyone. The owner's own trash listing is a separate path (S9).
  if (artifact.deletedAt !== null) return false

  // 2. Owner.
  if (isOwner(viewer, artifact.ownerId)) return true

  // 3. Org visibility. Session viewers only, per §5.1 — an API token stays owner-scoped.
  if (artifact.visibility === 'org' && viewer.kind === 'user' && viewer.isActive) return true

  // 4. S5 SEAM — share links do not exist yet, so a share-token viewer reads nothing. When S5
  //    lands, replace this with §5.1 branch 4: link.artifactId === artifact.id &&
  //    link.versionId === version.id && link.revokedAt == null && (link.expiresAt == null ||
  //    now < link.expiresAt). Nothing else in this function changes.
  if (viewer.kind === 'shareToken') return false

  // 5. Decision #26: an admin cannot read someone else's private artifact. Administering the
  //    instance is not permission to read its contents, and this is the headline privacy promise.
  if (viewer.kind === 'user' && viewer.role === 'admin') return false

  // 6. Everyone else.
  return false
}
