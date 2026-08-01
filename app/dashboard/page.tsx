import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Dashboard · enclave' }

/** Empty state only. S2 fills this with the artifact list. */
export default async function DashboardPage() {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave</p>
        <div className={styles.identity}>
          <span className={styles.email}>{sessionUser.email}</span>
          <form method="post" action="/api/auth/signout">
            <button className="button-secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className={styles.main}>
        <h1 className={styles.heading}>No artifacts yet</h1>
        <p className={styles.body}>
          Describe what you want and enclave generates it, then you choose who can see it — only
          you, everyone on this instance, or anyone holding a share link.
        </p>
      </main>
    </div>
  )
}
