import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { env } from '@/env'
import { MAX_LIST_LIMIT } from '@/lib/artifacts/list-query'
import { listTrashedArtifacts } from '@/lib/artifacts/trash'
import { getSessionUser } from '@/lib/auth/session'
import { TrashList } from './trash-list'
import styles from './page.module.css'

/**
 * The owner's trash (US-10). This is the separate path `canRead` branch 1 defers to: a deleted
 * artifact is unreadable everywhere else, and even here it can only be restored, never opened.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Trash · enclave' }

export default async function TrashPage() {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  // Paging UI is a later slice; the page takes the largest single page the API allows so the
  // list still shows everything a realistic trash holds, without the old unbounded query.
  const { items } = await listTrashedArtifacts(sessionUser.id, {
    limit: MAX_LIST_LIMIT,
    cursor: undefined,
  })

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave</p>
        <a className="button-secondary" href="/dashboard">
          Back to artifacts
        </a>
      </header>

      <main className={styles.main} id="main" tabIndex={-1}>
        <h1 className={styles.heading}>Trash</h1>
        <p className={styles.caption}>
          Deleted artifacts stay here for {env.TRASH_RETENTION_DAYS} days, then they and their files
          are erased for good. Restoring brings every version back — share links stay revoked.
        </p>

        <TrashList items={items} />
      </main>
    </div>
  )
}
