import type { ArtifactListItem } from '@/lib/artifacts/list'
import styles from './artifact-list.module.css'

/**
 * The owner's artifact list. Motion is a stagger on first paint only, 50 ms per row, capped so a
 * long list does not make the last row wait — see docs/motion.md § This project's surfaces. No
 * hover lift, and nothing re-animates on sort or pagination because the CSS animation runs once
 * per mount.
 */

const STAGGER_STEP_MS = 50
const MAX_STAGGERED_ROWS = 8

const VISIBILITY_LABEL = { private: 'Only me', org: 'Organization', public: 'Public' } as const

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kibibytes = bytes / 1024
  if (kibibytes < 1024) return `${kibibytes.toFixed(1)} KB`
  return `${(kibibytes / 1024).toFixed(1)} MB`
}

export function ArtifactList({ items }: { items: readonly ArtifactListItem[] }) {
  return (
    <section>
      <h1 className={styles.heading}>Artifacts</h1>
      <ul className={styles.list}>
        {items.map((item, index) => (
          <li
            key={item.id}
            className={styles.row}
            style={{
              animationDelay: `${Math.min(index, MAX_STAGGERED_ROWS) * STAGGER_STEP_MS}ms`,
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
            <p className={styles.path}>{item.viewUrl}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
