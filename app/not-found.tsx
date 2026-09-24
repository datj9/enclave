import type { Metadata } from 'next'
import Link from 'next/link'

import styles from './status-page.module.css'

export const metadata: Metadata = { title: 'Not found · enclave' }

export default function NotFound() {
  return (
    <main className={styles.screen}>
      <h1 className={styles.heading}>Not found</h1>
      <p className={styles.body}>
        This page does not exist, or you are not allowed to see that it does.
      </p>
      {/* `/` rather than /dashboard: this page also answers anonymous share-link visitors. */}
      <Link className={`button-secondary ${styles.action}`} href="/">
        Go to the home page
      </Link>
    </main>
  )
}
