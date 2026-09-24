import type { Metadata } from 'next'
import Link from 'next/link'
import { env } from '@/env'
import { listOwnedArtifacts } from '@/lib/artifacts/list'
import { DEFAULT_LIST_LIMIT } from '@/lib/artifacts/list-query'
import { requireSessionUser } from '@app/_components/session-gate'
import { SubmitButton } from '@app/_components/submit-button'
import { ArtifactList } from './artifact-list'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Dashboard · enclave' }

export default async function DashboardPage() {
  // layout.tsx has already redirected a signed-out visitor; repeating the check here costs
  // nothing (the lookup is memoised per request) and keeps the page safe on its own.
  const sessionUser = await requireSessionUser()

  const page = await listOwnedArtifacts(sessionUser.id, {
    limit: DEFAULT_LIST_LIMIT,
    cursor: undefined,
  })

  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave</p>
        <div className={styles.identity}>
          <span className={styles.email}>{sessionUser.email}</span>
          <Link className="button-primary" href="/new">
            New artifact
          </Link>
          <Link className="button-secondary" href="/trash">
            Trash
          </Link>
          <Link className="button-secondary" href="/settings/keys">
            Settings
          </Link>
          {sessionUser.role === 'admin' && (
            <Link className="button-secondary" href="/admin/users">
              Admin
            </Link>
          )}
          <form method="post" action="/api/auth/signout">
            <SubmitButton className="button-secondary" pendingLabel="Signing out">
              Sign out
            </SubmitButton>
          </form>
        </div>
      </header>

      <main className={styles.main} id="main" tabIndex={-1}>
        {page.items.length === 0 ? (
          <EmptyState />
        ) : (
          <ArtifactList
            initialItems={page.items}
            initialCursor={page.nextCursor}
            appUrl={env.APP_URL}
          />
        )}
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
      <Link className={`button-primary ${styles.cta}`} href="/new">
        Describe your first artifact
      </Link>
    </div>
  )
}
