import styles from './cta-strip.module.css'

export function CtaStrip() {
  return (
    <section className={styles.strip}>
      <div>
        <h2 className={styles.heading}>Your machine, your keys, your bucket.</h2>
        <p className={styles.line}>
          Nothing in enclave reports back to anyone. If this instance is already yours, sign in.
        </p>
      </div>
      <a className={`button-primary button-lg ${styles.action}`} href="/signin">
        Sign in →
      </a>
    </section>
  )
}
