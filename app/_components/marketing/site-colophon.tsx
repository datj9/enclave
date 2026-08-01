import { Fragment } from 'react'
import styles from './site-colophon.module.css'

interface Fact {
  readonly term: string
  readonly value: string
}

const FACTS: readonly Fact[] = [
  { term: 'Version', value: '0.1.0' },
  { term: 'Licence', value: 'Apache-2.0' },
  { term: 'Database', value: 'Postgres 17' },
  { term: 'Storage', value: 'S3-compatible object storage' },
  { term: 'Tenancy', value: 'One organization per deployment' },
  { term: 'Telemetry', value: 'None' },
]

export function SiteColophon() {
  return (
    <footer className={styles.footer}>
      <div>
        <p className={styles.wordmark}>enclave</p>
        <p className={styles.closing}>
          Self-hosted artifact generation and hosting, with the audience as an explicit setting.
        </p>
        <ul className={styles.links}>
          <li>
            <a className={styles.link} href="/signin">
              Sign in
            </a>
          </li>
          <li>
            <a className={styles.link} href="#self-host">
              Run it yourself
            </a>
          </li>
        </ul>
      </div>

      <dl className={styles.facts}>
        {FACTS.map((fact) => (
          <Fragment key={fact.term}>
            <dt className={styles.factTerm}>{fact.term}</dt>
            <dd className={styles.factValue}>{fact.value}</dd>
          </Fragment>
        ))}
      </dl>
    </footer>
  )
}
