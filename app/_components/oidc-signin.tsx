import styles from './oidc-signin.module.css'

/**
 * Rendered only when the instance has an OIDC provider configured (S11).
 *
 * A plain <a>, deliberately not next/link: the target is a route handler that answers with a
 * redirect to the identity provider, so it needs a full document navigation — a client-side
 * transition (or a prefetch) would fetch it as an RSC payload instead.
 */
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
