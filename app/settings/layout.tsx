import type { ReactNode } from 'react'

import { SettingsNav } from './settings-nav'
import styles from './settings.module.css'

/**
 * The settings shell. Each page below still resolves its own session, so this layout stays free of
 * the redirect — there is no role gate here, unlike `app/admin/layout.tsx`.
 */

export default function SettingsLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <p className={styles.wordmark}>enclave · settings</p>
        <SettingsNav />
        <a className="button-secondary" href="/dashboard">
          Back to artifacts
        </a>
      </header>

      <main className={styles.main}>{children}</main>
    </div>
  )
}
