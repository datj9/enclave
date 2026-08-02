import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { listApiTokens } from '@/lib/auth/bearer'
import { getSessionUser } from '@/lib/auth/session'
import { TokenManager } from './token-manager'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'API tokens · enclave' }

export default async function ApiTokensPage() {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  return (
    <>
      <h1 className={styles.heading}>API tokens</h1>
      <p className={styles.caption}>
        A token lets an agent or a CI job push a bundle on your behalf. It can do only what its
        scopes allow, and it sees only your artifacts.
      </p>

      <TokenManager initialTokens={await listApiTokens(sessionUser.id)} />
    </>
  )
}
