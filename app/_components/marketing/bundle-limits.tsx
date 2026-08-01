import { Fragment } from 'react'
import styles from './bundle-limits.module.css'

interface Limit {
  readonly term: string
  readonly value: string
}

/** Defaults straight out of .env.example — an operator can lower any of them. */
const LIMITS: readonly Limit[] = [
  { term: 'Files per bundle', value: '50' },
  { term: 'Bytes per file', value: '2 MB' },
  { term: 'Bytes per bundle', value: '10 MB' },
  { term: 'Extensions', value: 'html css js mjs json svg png jpg jpeg webp woff2 txt md' },
  { term: 'Unfinished uploads swept', value: 'After 15 minutes' },
]

export function BundleLimits() {
  return (
    <dl className={styles.limits}>
      {LIMITS.map((limit) => (
        <Fragment key={limit.term}>
          <dt className={styles.term}>{limit.term}</dt>
          <dd className={styles.value}>{limit.value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
