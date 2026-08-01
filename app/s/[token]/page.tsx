import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { authorizeArtifactRead, shareViewerRef } from '@/lib/artifacts/authorize'
import { artifactViewUrl } from '@/lib/artifacts/naming'
import { signHandoffToken } from '@/lib/handoff'
import { resolveShareLinkByToken } from '@/lib/shares/links'
import { ArtifactFrame } from '../../a/[id]/artifact-frame'
import styles from './page.module.css'

/**
 * grill-result §4.2 steps 1–3 for a share link — the same flow as `app/a/[id]/page.tsx`, with the
 * link standing in for the session. There is no sign-in here and none is wanted: the token *is*
 * the capability (US-5).
 *
 * Every rejection is one `notFound()`, so an expired, revoked, unknown or purged link is
 * indistinguishable. Nothing on this path logs the token — the viewer ref carries the link's id.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Shared artifact · enclave',
  // A capability URL must stay out of search indexes and out of referrer headers.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export default async function SharedArtifactPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const resolved = await resolveShareLinkByToken(decodeURIComponent(token))
  if (resolved === null) notFound()

  // The link is loaded but not judged here: `canRead` branch 4 decides, inside this call, whether
  // it is still active and still pinned to a version that exists.
  const viewerRef = shareViewerRef(resolved.shareLinkId)
  const authorized = await authorizeArtifactRead(resolved.link.artifactId, viewerRef)
  if (authorized === null) notFound()

  const handoffToken = await signHandoffToken({
    artifactId: authorized.artifactId,
    versionId: authorized.versionId,
    viewerRef,
  })

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <p className={styles.brand}>enclave</p>
        <p className={styles.note}>Shared with you · read-only</p>
      </header>
      <ArtifactFrame
        enterUrl={`${artifactViewUrl(authorized.artifactId)}__enter?t=${encodeURIComponent(handoffToken)}`}
      />
    </div>
  )
}
