import { REPOSITORY_URL } from './repository'
import { revealStyle } from './reveal'
import styles from './marketing-nav.module.css'

export function MarketingNav() {
  return (
    <header className={styles.nav} data-reveal style={revealStyle(0)}>
      <p className={styles.wordmark}>enclave</p>
      <div className={styles.actions}>
        <a className={styles.action} href={REPOSITORY_URL}>
          Source code
        </a>
        <a className={styles.action} href="/signin">
          Sign in
        </a>
      </div>
    </header>
  )
}
