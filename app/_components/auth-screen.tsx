import type { ReactNode } from 'react'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password'
import styles from './auth-screen.module.css'

interface AuthScreenProps {
  readonly heading: string
  readonly caption: string
  /** Route handler the form posts to. Plain HTML form — no client JavaScript required. */
  readonly action: string
  readonly submitLabel: string
  readonly passwordAutoComplete?: 'new-password' | 'current-password'
  readonly passwordHint?: string
  readonly errorMessage: string | null
  /** Success copy rendered with `role="status"` — forgot-password's generic success page. */
  readonly successMessage?: string | null
  /** Optional sign-in route rendered below the form — S11 puts the OIDC button here. */
  readonly alternative?: ReactNode
  /** Rendered after the form, above the alternative — the "Forgot password?" link on sign-in. */
  readonly footer?: ReactNode
  /** Extra values the route needs — S10 posts the invite token this way. Never rendered visibly. */
  readonly hiddenFields?: Readonly<Record<string, string>>
  readonly showEmail?: boolean // default true
  readonly showPassword?: boolean // default true
}

/** Shared shell for the unauthenticated app screens: /setup, /signin, and S10's /signup. */
export function AuthScreen({
  heading,
  caption,
  action,
  submitLabel,
  passwordAutoComplete,
  passwordHint,
  errorMessage,
  successMessage,
  alternative,
  footer,
  hiddenFields,
  showEmail = true,
  showPassword = true,
}: AuthScreenProps) {
  return (
    <main className={styles.screen}>
      <div className={styles.panel}>
        <p className={styles.wordmark}>enclave</p>
        <h1 className={styles.heading}>{heading}</h1>
        <p className={styles.caption}>{caption}</p>

        <form className={styles.form} method="post" action={action}>
          {Object.entries(hiddenFields ?? {}).map(([name, value]) => (
            <input key={name} name={name} type="hidden" value={value} />
          ))}

          {errorMessage !== null && (
            <p className="form-error" role="alert">
              {errorMessage}
            </p>
          )}

          {successMessage !== null && successMessage !== undefined && (
            <p className={styles.status} role="status">
              {successMessage}
            </p>
          )}

          {showEmail && (
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
          )}

          {showPassword && (
            <div className="field">
              <label className="field-label" htmlFor="password">
                Password
              </label>
              <input
                className="input"
                id="password"
                name="password"
                type="password"
                autoComplete={passwordAutoComplete ?? 'current-password'}
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                required
                autoFocus={!showEmail}
              />
              {passwordHint !== undefined && <p className={styles.hint}>{passwordHint}</p>}
            </div>
          )}

          <button className="button-primary" type="submit">
            {submitLabel}
          </button>
        </form>

        {footer !== undefined && <div className={styles.footer}>{footer}</div>}
        {alternative}
      </div>
    </main>
  )
}
