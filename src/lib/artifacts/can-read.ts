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

/**
 * The share link a `shareToken` viewer presented, loaded but not judged: branch 4 below is what
 * decides whether it still grants anything.
 */
export interface ShareLinkBinding {
  readonly artifactId: string
  readonly versionId: string
  readonly revokedAt: Date | null
  readonly expiresAt: Date | null
}

export type Viewer =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly role: UserRole
      readonly isActive: boolean
    }
  | {
      readonly kind: 'shareToken'
      readonly shareLinkId: string
      readonly link: ShareLinkBinding
      /**
       * Postgres `now()`, read in the same statement as the link. Branch 4 needs a clock and §7
       * forbids the app server's, so the caller carries the database's in rather than this
       * function reaching for `Date.now()`.
       */
      readonly databaseNow: Date
    }
  | { readonly kind: 'apiToken'; readonly userId: string }
  /**
   * A visitor with no session and no link — the only viewer kind that carries no identity at all.
   * Branch 5 is the only branch that can grant it anything, so a `public` artifact is the only
   * thing it ever reads.
   */
  | { readonly kind: 'anonymous' }

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

  // 4. Share link. The version match is what pins the link: a newer version of the same artifact
  //    is a different `version.id` and this returns false for it.
  if (viewer.kind === 'shareToken') {
    const { link } = viewer
    return (
      link.artifactId === artifact.id &&
      link.versionId === version.id &&
      link.revokedAt === null &&
      (link.expiresAt === null || viewer.databaseNow < link.expiresAt)
    )
  }

  // 5. Public visibility: the widest audience, and the only branch that grants an anonymous
  //    viewer anything. Deliberately *after* branch 4 — a share-token viewer is judged as a link
  //    holder and nothing else, so a revoked link stays dead and never falls through to here to
  //    read the old version it was pinned to.
  if (artifact.visibility === 'public') return true

  // 6. Decision #26: an admin cannot read someone else's private artifact. Administering the
  //    instance is not permission to read its contents, and this is the headline privacy promise.
  if (viewer.kind === 'user' && viewer.role === 'admin') return false

  // 7. Everyone else.
  return false
}
