import { eq } from 'drizzle-orm'
import { cache } from 'react'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { getSessionUser } from '@/lib/auth/session'
import {
  ANONYMOUS_VIEWER_REF,
  authorizeArtifactRead,
  userViewerRef,
  type AuthorizedVersion,
} from './authorize'

/**
 * What `/a/{id}` needs before it can render anything: which viewer the read was authorized as, the
 * version they get, and the title — for the `<h1>` and for `generateMetadata`.
 *
 * Wrapped in `cache` because Next.js calls `generateMetadata` and the page component separately
 * within one request, and the gate must not be asked twice per render. The cache is per-request;
 * it never spans two viewers.
 */

export type ArtifactPageRead =
  | {
      readonly kind: 'ok'
      /** The ref the read was granted for — the same one that goes into the handoff token. */
      readonly viewerRef: string
      readonly authorized: AuthorizedVersion
      readonly title: string
      readonly isSignedIn: boolean
    }
  /** No session, and nothing about this id is readable without one. Signing in may change that. */
  | { readonly kind: 'signin' }
  /** Refused for a viewer who is already signed in: a 404, never a 403 (§7). */
  | { readonly kind: 'missing' }

/**
 * A session is tried first so a signed-in owner or member keeps their identity in the audit trail.
 * The anonymous retry only ever succeeds on a `public` artifact — `canRead` branch 5 is the only
 * branch that grants an anonymous viewer anything — which is also what makes a deactivated account
 * fall back to exactly the public internet's view rather than to a sign-in screen.
 */
async function authorizeAsViewer(
  artifactId: string,
  sessionUserId: string | null,
): Promise<{ readonly viewerRef: string; readonly authorized: AuthorizedVersion } | null> {
  if (sessionUserId !== null) {
    const viewerRef = userViewerRef(sessionUserId)
    const authorized = await authorizeArtifactRead(artifactId, viewerRef)
    if (authorized !== null) return { viewerRef, authorized }
  }

  const authorized = await authorizeArtifactRead(artifactId, ANONYMOUS_VIEWER_REF)
  return authorized === null ? null : { viewerRef: ANONYMOUS_VIEWER_REF, authorized }
}

export const readArtifactPage = cache(
  async (artifactId: string): Promise<ArtifactPageRead> => {
    const sessionUser = await getSessionUser()
    const granted = await authorizeAsViewer(artifactId, sessionUser?.id ?? null)

    if (granted === null) return sessionUser === null ? { kind: 'signin' } : { kind: 'missing' }

    // Only after the gate said yes, and only the display fields: the read decision is never made
    // from this row.
    const [row] = await db
      .select({ title: artifacts.title })
      .from(artifacts)
      .where(eq(artifacts.id, artifactId))
      .limit(1)

    if (row === undefined) return { kind: 'missing' }

    return {
      kind: 'ok',
      viewerRef: granted.viewerRef,
      authorized: granted.authorized,
      title: row.title,
      isSignedIn: sessionUser !== null,
    }
  },
)
