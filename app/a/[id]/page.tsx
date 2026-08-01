import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { authorizeArtifactRead, userViewerRef } from '@/lib/artifacts/authorize'
import { artifactViewUrl } from '@/lib/artifacts/naming'
import { getSessionUser } from '@/lib/auth/session'
import { signHandoffToken } from '@/lib/handoff'
import { listShareLinks, listShareableVersions } from '@/lib/shares/manage'
import { ArtifactFrame } from './artifact-frame'
import { PrivacySwitch } from './privacy-switch'
import { ShareDialog } from './share-dialog'
import styles from './page.module.css'

/**
 * grill-result §4.2 steps 1–3. Every authorization decision in the viewer path is made here, on
 * the app origin, where the session lives; the artifact origin only ever sees the signed token.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Artifact · enclave' }

export default async function ArtifactViewerPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  const { id } = await params
  const viewerRef = userViewerRef(sessionUser.id)
  const authorized = await authorizeArtifactRead(id, viewerRef)
  if (authorized === null) notFound()

  const handoffToken = await signHandoffToken({
    artifactId: authorized.artifactId,
    versionId: authorized.versionId,
    viewerRef,
  })

  // Only the owner may create or revoke a share, so a reader never pays for these two queries.
  const shareState = authorized.isOwner
    ? {
        versions: await listShareableVersions(id, viewerRef),
        shares: await listShareLinks(id, viewerRef),
      }
    : null

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <a className={styles.back} href="/dashboard">
          ← Artifacts
        </a>
        <p className={styles.origin}>{new URL(artifactViewUrl(id)).host}</p>
        {shareState !== null && (
          <div className={styles.ownerControls}>
            <PrivacySwitch artifactId={id} initialVisibility={authorized.visibility} />
            <ShareDialog
              artifactId={id}
              versions={shareState.versions}
              initialShares={shareState.shares}
            />
          </div>
        )}
      </header>
      <ArtifactFrame
        enterUrl={`${artifactViewUrl(id)}__enter?t=${encodeURIComponent(handoffToken)}`}
      />
    </div>
  )
}
