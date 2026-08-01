import type { ReactNode } from 'react'
import { notFound, redirect } from 'next/navigation'

import { env } from '@/env'
import { openRegistrationWarning } from '@/lib/admin/registration-notice'
import { getSessionUser } from '@/lib/auth/session'
import { AdminNav } from './admin-nav'
import styles from './admin.module.css'

/**
 * The admin console shell (US-11). A signed-in member gets 404 rather than 403: unlike the API,
 * where 403 is the specified answer, a page has no caller to explain the refusal to.
 *
 * Being here grants nothing over artifact contents. Every read still runs `canRead`, whose branch 5
 * refuses an admin someone else's private artifact (§5.1, decision #26) — no route under this
 * layout loads a manifest or a byte of artifact storage.
 */

export const dynamic = 'force-dynamic'

export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')
  if (sessionUser.role !== 'admin') notFound()

  const warning = openRegistrationWarning(env.ALLOW_OPEN_REGISTRATION)

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave · admin</p>
        <AdminNav />
        <a className="button-secondary" href="/dashboard">
          Back to artifacts
        </a>
      </header>

      {warning === null ? (
        <div />
      ) : (
        <p className={styles.warning} role="status">
          {warning}
        </p>
      )}

      <main className={styles.main}>{children}</main>
    </div>
  )
}
