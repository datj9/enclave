import styles from './list-skeleton.module.css'

/**
 * The `loading.tsx` placeholder for the signed-in list pages (dashboard, trash). Both are
 * `force-dynamic` and wait on Postgres before the first byte, so a soft navigation from the
 * header used to sit on the old page with no sign that anything was happening.
 *
 * Shaped like the page it stands in for — the same header bar and a column of rows — so the swap
 * does not jump. It holds no links or headings: the real page replaces it within a request, and a
 * duplicate "New artifact" link or heading would only be something for a test or a screen reader to
 * trip on. The one thing it says is the polite status line.
 *
 * The shimmer is functional motion (docs/motion.md § Accessibility), so it keeps running under
 * reduced motion; it animates opacity only.
 */
export function ListSkeleton({
  label,
  rows = 4,
}: {
  /** Read to assistive technology while the page loads, e.g. "Loading artifacts". */
  readonly label: string
  readonly rows?: number
}) {
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave</p>
        <span className={`${styles.block} ${styles.barBlock}`} aria-hidden="true" />
      </header>

      <main className={styles.main} aria-busy="true">
        <p className="sr-only" role="status">
          {label}
        </p>
        <span className={`${styles.block} ${styles.heading}`} aria-hidden="true" />
        <ul className={styles.list} aria-hidden="true">
          {Array.from({ length: rows }, (_, index) => (
            <li className={styles.row} key={index}>
              <span className={`${styles.block} ${styles.title}`} />
              <span className={`${styles.block} ${styles.meta}`} />
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}
