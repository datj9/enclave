import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getSessionUser } from '@/lib/auth/session'
import { getStoredProviderKey } from '@/lib/providers/user-keys'
import { readQuotaUsage } from '@/lib/quota'
import { KeyManager } from './key-manager'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Provider key · enclave' }

export default async function ProviderKeyPage() {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  const storedKey = await getStoredProviderKey(sessionUser.id)
  const usage = await readQuotaUsage(sessionUser.id, storedKey !== null)

  return (
    <>
      <h1 className={styles.heading}>Provider key</h1>
      <p className={styles.caption}>
        Bring your own model key and generations run on your account, with a higher daily limit. The
        key is encrypted before it is stored and is never shown again — only its last four
        characters.
      </p>

      <section className={styles.usage} aria-label="Current usage">
        <p className={styles.usageRow}>
          <span>Today</span>
          <span className={styles.usageValue}>
            {usage.dailyCount} / {usage.dailyLimit} generations
          </span>
        </p>
        <p className={styles.usageRow}>
          <span>This hour</span>
          <span className={styles.usageValue}>
            {usage.hourlyCount} / {usage.hourlyLimit} generations
          </span>
        </p>
      </section>

      <KeyManager initialKey={storedKey} />
    </>
  )
}
