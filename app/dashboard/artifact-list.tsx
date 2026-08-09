'use client'

import { useState } from 'react'

import type { ArtifactListItem, ArtifactListPage } from '@/lib/artifacts/list'
import styles from './artifact-list.module.css'

/**
 * The owner's artifact list. Motion is a stagger on first paint only, 50 ms per row, capped so a
 * long list does not make the last row wait — see docs/motion.md § This project's surfaces. No
 * hover lift, and a row appended by Load more enters with no delay at all, so paging never
 * restages the list.
 */

const STAGGER_STEP_MS = 50
const MAX_STAGGERED_ROWS = 8

const LOAD_FAILED = 'Those artifacts did not load. Try again.'

const VISIBILITY_LABEL = { private: 'Only me', org: 'Organization', public: 'Public' } as const

interface ArtifactListResponse {
  readonly data: ArtifactListPage
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kibibytes = bytes / 1024
  if (kibibytes < 1024) return `${kibibytes.toFixed(1)} KB`
  return `${(kibibytes / 1024).toFixed(1)} MB`
}

/** `naming.ts` builds this from `env`, which never reaches the browser — hence the origin prop. */
function artifactPageUrl(appUrl: string, artifactId: string): string {
  return new URL(`/a/${artifactId}`, appUrl).toString()
}

export function ArtifactList({
  initialItems,
  initialCursor,
  appUrl,
}: {
  readonly initialItems: readonly ArtifactListItem[]
  readonly initialCursor: string | null
  readonly appUrl: string
}) {
  // Seeded once: React ignores later prop changes, so a soft navigation keeps the loaded list.
  const [items, setItems] = useState<readonly ArtifactListItem[]>(initialItems)
  const [cursor, setCursor] = useState(initialCursor)
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // Appended rows mount fresh and would otherwise inherit an entrance delay meant for first paint.
  const [firstPaintCount] = useState(initialItems.length)

  async function loadMore(): Promise<void> {
    // `aria-disabled` keeps focus on the button but still fires the click.
    if (isBusy || cursor === null) return
    setIsBusy(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`/api/v1/artifacts?cursor=${encodeURIComponent(cursor)}`)
      if (!response.ok) {
        setErrorMessage(LOAD_FAILED)
        return
      }

      const body = (await response.json()) as ArtifactListResponse
      setItems((previous) => [...previous, ...body.data.items])
      setCursor(body.data.nextCursor)
    } catch {
      setErrorMessage(LOAD_FAILED)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <section>
      <h1 className={styles.heading}>Artifacts</h1>
      <ul className={styles.list}>
        {items.map((item, index) => (
          <li
            key={item.id}
            className={styles.row}
            style={{
              animationDelay:
                index < firstPaintCount
                  ? `${Math.min(index, MAX_STAGGERED_ROWS) * STAGGER_STEP_MS}ms`
                  : '0ms',
            }}
          >
            <a className={styles.link} href={`/a/${item.id}`}>
              <span className={styles.title}>{item.title}</span>
            </a>
            <p className={styles.meta}>
              <span className={styles.visibility}>{VISIBILITY_LABEL[item.visibility]}</span>
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
              <span className="tabular">v{item.versionNo}</span>
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
              <span className="tabular">{item.fileCount} files</span>
              <span className={styles.separator} aria-hidden="true">
                ·
              </span>
              <span className="tabular">{formatBytes(item.totalBytes)}</span>
            </p>
            <p className={styles.path}>{artifactPageUrl(appUrl, item.id)}</p>
          </li>
        ))}
      </ul>

      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      {/* The slot outlives the button — unmounting it mid-press drops focus to <body>. */}
      {(cursor !== null || items.length > firstPaintCount) && (
        <div className={styles.pager}>
          {cursor !== null ? (
            <button
              className="button-secondary"
              type="button"
              aria-disabled={isBusy}
              data-testid="artifacts-load-more"
              onClick={() => void loadMore()}
            >
              Load more
            </button>
          ) : (
            <p className={styles.pagerNote} role="status">
              All {items.length} artifacts loaded.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
