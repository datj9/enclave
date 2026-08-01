import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { listOwnedArtifacts } from '@/lib/artifacts/list'
import { DEFAULT_LIST_LIMIT } from '@/lib/artifacts/list-query'
import { getSessionUser } from '@/lib/auth/session'
import { ArtifactList } from './artifact-list'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Dashboard · enclave' }

export default async function DashboardPage() {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  const page = await listOwnedArtifacts(sessionUser.id, {
    limit: DEFAULT_LIST_LIMIT,
    cursor: undefined,
  })

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave</p>
        <div className={styles.identity}>
          <span className={styles.email}>{sessionUser.email}</span>
          <a className="button-secondary" href="/trash">
            Trash
          </a>
          {sessionUser.role === 'admin' && (
            <a className="button-secondary" href="/admin/users">
              Admin
            </a>
          )}
          <form method="post" action="/api/auth/signout">
            <button className="button-secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className={styles.main}>
        {page.items.length === 0 ? <EmptyState /> : <ArtifactList items={page.items} />}
      </main>
    </div>
  )
}

function EmptyState() {
  return (
    <div className={styles.empty}>
      <h1 className={styles.heading}>No artifacts yet</h1>
      <p className={styles.body}>
        Describe what you want and enclave generates it, then you choose who can see it — only you,
        everyone on this instance, or anyone holding a share link.
      </p>
    </div>
  )
}
