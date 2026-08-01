import { revealStyle } from './reveal'
import styles from './marketing-nav.module.css'

export function MarketingNav() {
  return (
    <header className={styles.nav} data-reveal style={revealStyle(0)}>
      <p className={styles.wordmark}>enclave</p>
      <a className={styles.action} href="/signin">
        Sign in
      </a>
    </header>
  )
}
