import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { artifactPageUrl, artifactViewUrl } from '@/lib/artifacts/naming'
import { readArtifactPage } from '@/lib/artifacts/page-read'
import { artifactPageMetadata } from '@/lib/artifacts/seo'
import { signHandoffToken } from '@/lib/handoff'
import { env } from '@/env'
import { listShareLinks, listShareableVersions } from '@/lib/shares/manage'
import { ArtifactFrame } from './artifact-frame'
import { DeleteDialog } from './delete-dialog'
import { DownloadMenu } from './download-menu'
import { PrivacySwitch } from './privacy-switch'
import { ShareDialog } from './share-dialog'
import styles from './page.module.css'

/**
 * grill-result §4.2 steps 1–3. Every authorization decision in the viewer path is made here, on
 * the app origin, where the session lives; the artifact origin only ever sees the signed token.
 *
 * This is also the only indexable page an artifact has, so it carries the artifact's metadata —
 * and `robots: noindex` for every level except `public` (src/lib/artifacts/seo.ts).
 */

export const dynamic = 'force-dynamic'

/** Nothing readable at this id, for this viewer. Says so without naming the artifact. */
const UNREADABLE_METADATA: Metadata = {
  title: 'Artifact · enclave',
  robots: { index: false, follow: false },
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const page = await readArtifactPage(id)
  if (page.kind !== 'ok') return UNREADABLE_METADATA

  return artifactPageMetadata({
    title: page.title,
    visibility: page.authorized.visibility,
    canonicalUrl: artifactPageUrl(id),
  })
}

export default async function ArtifactViewerPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const page = await readArtifactPage(id)

  // A signed-out visitor is sent to sign in rather than to a 404: for an org artifact the sign-in
  // is exactly what is missing, and the 404 would be a lie. A signed-in viewer who is refused gets
  // the 404, which is what keeps a private artifact indistinguishable from one that never existed.
  if (page.kind === 'signin') redirect('/signin')
  if (page.kind === 'missing') notFound()

  const { authorized, viewerRef, title, isSignedIn, categories } = page

  const handoffToken = await signHandoffToken({
    artifactId: authorized.artifactId,
    versionId: authorized.versionId,
    viewerRef,
  })

  // Only the owner may create or revoke a share, and only the owner sees the privacy switch the
  // live count feeds, so a reader never pays for these two queries.
  const shareState = authorized.isOwner
    ? {
        versions: await listShareableVersions(id, viewerRef),
        shareLinks: await listShareLinks(id, viewerRef),
      }
    : null

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        {isSignedIn ? (
          <a className={styles.back} href="/dashboard">
            ← Artifacts
          </a>
        ) : (
          <Link className={styles.back} href="/">
            enclave
          </Link>
        )}
        {/*
          The page's one heading. It is the artifact's title rather than the chrome's, because on a
          public artifact this is the only text a crawler or a link unfurler ever sees — the
          document itself lives in a cross-origin iframe.
        */}
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.origin}>{new URL(artifactViewUrl(id)).host}</p>
        {categories.length > 0 && (
          <p className={styles.tags}>{categories.map((category) => category.name).join(' · ')}</p>
        )}
        {/* Visible to every viewer, not just the owner: the download is the viewer's own copy. */}
        <DownloadMenu downloadBasePath={`/a/${id}/download`} />
        {shareState !== null && (
          <div className={styles.ownerControls}>
            <PrivacySwitch
              artifactId={id}
              initialVisibility={authorized.visibility}
              liveShareLinkCount={shareState.shareLinks.liveCount}
            />
            <ShareDialog
              artifactId={id}
              versions={shareState.versions}
              initialShares={shareState.shareLinks.items}
              initialLiveCount={shareState.shareLinks.liveCount}
            />
            <DeleteDialog
              artifactId={id}
              initialLiveShareCount={shareState.shareLinks.liveCount}
              retentionDays={env.TRASH_RETENTION_DAYS}
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
