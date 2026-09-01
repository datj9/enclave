import type { NextRequest } from 'next/server'

import {
  authorizeArtifactRead,
  shareLinkIdFromViewerRef,
  userIdFromViewerRef,
} from '@/lib/artifacts/authorize'
import { createGrantCookie } from '@/lib/artifacts/grant'
import {
  artifactEntryUnavailable,
  artifactIdFromHost,
  artifactNotAvailable,
  requestHost,
} from '@/lib/artifacts/origin'
import { recordAuditEvent } from '@/lib/audit'
import { consumeHandoffToken } from '@/lib/handoff'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { recordShareLinkView } from '@/lib/shares/links'

/**
 * grill-result §4.2 step 4. Reached only through the proxy's host rewrite, so `id` is the
 * artifact named by the hostname and is re-derived from the `Host` header here anyway.
 *
 * Every rejection is the same 404 (§7), and nothing on this path logs the token or the cookie.
 */

export const dynamic = 'force-dynamic'

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const hostArtifactId = artifactIdFromHost(requestHost(request))
  const { id } = await context.params
  if (hostArtifactId === null || hostArtifactId !== id) return artifactNotAvailable()

  const token = request.nextUrl.searchParams.get('t')
  // §5.1: must sit strictly above authorizeArtifactRead — no Postgres yet, so this answer is
  // identical for an artifact that exists and one that never did.
  if (token === null) return artifactEntryUnavailable(hostArtifactId, request.headers)

  // Burns the token: a replay of this exact request lands on the same re-entry path below.
  const claims = await consumeHandoffToken(token)
  // §5.1: same invariant — JWT + in-process Map only, no database (§5.1 / handoff.ts).
  if (claims === null || claims.artifactId !== hostArtifactId) {
    return artifactEntryUnavailable(hostArtifactId, request.headers)
  }

  // §7: the grant the token stands for may have been revoked in the 30 seconds it was valid.
  const authorized = await authorizeArtifactRead(claims.artifactId, claims.viewerRef)
  if (authorized === null || authorized.versionId !== claims.versionId) {
    return artifactNotAvailable()
  }

  // §5.2: `artifact.view` is recorded for non-private artifacts only. Logging every read of a
  // private artifact would build a record of what its owner looks at, which is the opposite of
  // what "only me" promises.
  //
  // A share-link view is always recorded whatever the visibility: the reader is anonymous and
  // outside the instance, which is the case the owner most needs the trail for (§5.2, A.12.4.1).
  //
  // A `public` artifact records its views the same way an org one does, with no actor — the row is
  // the timestamp and the IP, which is all an anonymous read can honestly claim.
  const shareLinkId = shareLinkIdFromViewerRef(claims.viewerRef)
  if (shareLinkId !== null || authorized.visibility !== 'private') {
    await recordAuditEvent({
      action: 'artifact.view',
      actorUserId: userIdFromViewerRef(claims.viewerRef),
      actorShareLinkId: shareLinkId,
      actorIp: clientIpFromHeaders(request.headers),
      artifactId: authorized.artifactId,
      versionId: authorized.versionId,
      shareLinkId,
    })
  }

  if (shareLinkId !== null) await recordShareLinkView(shareLinkId)

  const setCookie = await createGrantCookie({
    artifactId: authorized.artifactId,
    versionId: authorized.versionId,
    viewerRef: claims.viewerRef,
  })

  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': setCookie, 'cache-control': 'no-store' },
  })
}
