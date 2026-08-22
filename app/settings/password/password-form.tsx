import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth/password'
import styles from './page.module.css'

interface PasswordFormProps {
  readonly errorMessage: string | null
  readonly successMessage: string | null
}

export function PasswordForm({ errorMessage, successMessage }: PasswordFormProps) {
  return (
    <form className={styles.form} method="post" action="/api/auth/change-password">
      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      {successMessage !== null && (
        <p className={styles.status} role="status">
          {successMessage}
        </p>
      )}

      <div className="field">
        <label className="field-label" htmlFor="currentPassword">
          Current password
        </label>
        <input
          className="input"
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          maxLength={PASSWORD_MAX_LENGTH}
          required
          autoFocus
        />
      </div>

      <div className="field">
        <label className="field-label" htmlFor="newPassword">
          New password
        </label>
        <input
          className="input"
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          required
        />
        <p className={styles.hint}>{`At least ${PASSWORD_MIN_LENGTH} characters.`}</p>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="confirmNewPassword">
          Confirm new password
        </label>
        <input
          className="input"
          id="confirmNewPassword"
          name="confirmNewPassword"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          required
        />
      </div>

      <button className="button-primary" type="submit">
        Update password
      </button>
    </form>
  )
}
