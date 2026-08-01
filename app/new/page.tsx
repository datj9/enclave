import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getSessionUser } from '@/lib/auth/session'
import { PromptComposer } from './prompt-composer'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'New artifact · enclave' }

export default async function NewArtifactPage() {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <a className={styles.wordmark} href="/dashboard">
          enclave
        </a>
        <span className={styles.email}>{sessionUser.email}</span>
      </header>

      <main className={styles.main}>
        <h1 className={styles.heading}>New artifact</h1>
        <p className={styles.body}>
          Describe what you want. The model writes the files, they are stored as one version, and
          only you can see it until you say otherwise.
        </p>
        <PromptComposer />
      </main>
    </div>
  )
}
