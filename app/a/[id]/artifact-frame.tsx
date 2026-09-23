'use client'

import { useEffect, useRef, useState } from 'react'

import styles from './artifact-frame.module.css'

/**
 * docs/motion.md, iframe-load row: a shimmering skeleton until `load` fires, then a 150 ms
 * opacity crossfade. The iframe is full-size from the first paint and the skeleton sits on top
 * of it — nothing animates the frame's size.
 */

/** §7: a missing wildcard certificate never fires `load`, so a stall is the only signal. */
const TLS_HELP_AFTER_MS = 8000

/** Used where the page has no title to give — the share-link viewer names nothing to a stranger. */
const FALLBACK_FRAME_TITLE = 'Artifact'

export function ArtifactFrame({
  enterUrl,
  title = FALLBACK_FRAME_TITLE,
}: {
  readonly enterUrl: string
  /**
   * The iframe's accessible name. A screen reader lists frames by title, so "Artifact" on every
   * page tells the listener nothing; the artifact's own title says which document this is.
   */
  readonly title?: string | undefined
}) {
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isStalled, setIsStalled] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (hasLoaded) return undefined
    const timer = setTimeout(() => setIsStalled(true), TLS_HELP_AFTER_MS)
    return () => clearTimeout(timer)
  }, [hasLoaded])

  return (
    <div className={styles.stage}>
      <iframe
        ref={frameRef}
        className={styles.frame}
        data-loaded={hasLoaded}
        src={enterUrl}
        title={title}
        // A stable hook for tests: the title is now the artifact's, and differs per page.
        data-testid="artifact-frame"
        // Exactly grill-result §4.3. `allow-same-origin` gives the artifact localStorage and
        // IndexedDB, and is safe ONLY because every artifact has its own unguessable origin,
        // distinct from the app's. If the origin model ever collapses to one shared artifact
        // host, this attribute must lose `allow-same-origin` in the same commit.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        onLoad={() => setHasLoaded(true)}
      />

      {hasLoaded ? null : (
        <div className={styles.skeleton} data-testid="artifact-skeleton" aria-hidden="true">
          <span className={styles.shimmer} />
        </div>
      )}

      {isStalled && !hasLoaded ? <SetupHelp url={enterUrl} /> : null}
    </div>
  )
}

function SetupHelp({ url }: { url: string }) {
  return (
    <div className={styles.help} role="status">
      <h2 className={styles.helpHeading}>This artifact origin is not reachable</h2>
      <p className={styles.helpBody}>
        Artifacts are served from their own hostname so one cannot read another. That needs wildcard
        DNS and a wildcard TLS certificate for the origin below.
      </p>
      <p className={styles.helpOrigin}>{new URL(url).host}</p>
      <p className={styles.helpBody}>
        Point a wildcard record at this instance and set <code>ARTIFACT_ORIGIN_TEMPLATE</code> to
        the matching https origin, then reload.
      </p>
    </div>
  )
}
