import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password'
import styles from './auth-screen.module.css'

interface AuthScreenProps {
  readonly heading: string
  readonly caption: string
  /** Route handler the form posts to. Plain HTML form — no client JavaScript required. */
  readonly action: string
  readonly submitLabel: string
  readonly passwordAutoComplete: 'new-password' | 'current-password'
  readonly passwordHint?: string
  readonly errorMessage: string | null
}

/** Shared shell for /setup and /signin — the only two unauthenticated app screens in S1. */
export function AuthScreen({
  heading,
  caption,
  action,
  submitLabel,
  passwordAutoComplete,
  passwordHint,
  errorMessage,
}: AuthScreenProps) {
  return (
    <main className={styles.screen}>
      <div className={styles.panel}>
        <p className={styles.wordmark}>enclave</p>
        <h1 className={styles.heading}>{heading}</h1>
        <p className={styles.caption}>{caption}</p>

        <form className={styles.form} method="post" action={action}>
          {errorMessage !== null && (
            <p className="form-error" role="alert">
              {errorMessage}
            </p>
          )}

          <div className="field">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              className="input"
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              autoComplete={passwordAutoComplete}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              required
            />
            {passwordHint !== undefined && <p className={styles.hint}>{passwordHint}</p>}
          </div>

          <button className="button-primary" type="submit">
            {submitLabel}
          </button>
        </form>
      </div>
    </main>
  )
}
