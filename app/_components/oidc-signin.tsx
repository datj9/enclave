import styles from './oidc-signin.module.css'

/** Rendered only when the instance has an OIDC provider configured (S11). */
export function OidcSignin() {
  return (
    <div className={styles.alternative}>
      <p className={styles.divider}>or</p>
      <a className={`button-secondary ${styles.action}`} href="/api/auth/oidc/start">
        Sign in with your identity provider
      </a>
    </div>
  )
}
