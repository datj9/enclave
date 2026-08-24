import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { getSessionUser } from '@/lib/auth/session'
import { hasLocalPassword } from '@/lib/auth/change-password'
import { OIDC_ONLY_PASSWORD_COPY, PASSWORD_UPDATED } from '@/lib/auth/change-password'
import { PasswordForm } from './password-form'
import styles from './page.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Password · enclave' }

interface PasswordSettingsPageProps {
  searchParams: Promise<{ error?: string; updated?: string }>
}

function errorMessageFor(error: string | undefined): string | null {
  if (error === 'wrong_current') return 'Current password is incorrect.'
  if (error === 'mismatch') return 'New password and confirmation do not match.'
  if (error === 'password') return 'Enter a password of at least 12 characters.'
  if (error === 'same') return 'Choose a different password.'
  if (error === 'no_password') return OIDC_ONLY_PASSWORD_COPY
  if (error === 'malformed')
    return 'Enter your current password and a new password of at least 12 characters.'
  if (error === 'rate_limited') return 'Too many attempts, please try again later.'
  return null
}

export default async function PasswordSettingsPage({ searchParams }: PasswordSettingsPageProps) {
  const sessionUser = await getSessionUser()
  if (sessionUser === null) redirect('/signin')

  const canChange = await hasLocalPassword(sessionUser.id)
  const { error, updated } = await searchParams

  return (
    <>
      <h1 className={styles.heading}>Password</h1>
      {canChange ? (
        <>
          <p className={styles.caption}>Changing your password signs out other browsers.</p>
          <PasswordForm
            errorMessage={errorMessageFor(error)}
            successMessage={updated === '1' ? PASSWORD_UPDATED : null}
          />
        </>
      ) : (
        <p className={styles.caption}>{OIDC_ONLY_PASSWORD_COPY}</p>
      )}
    </>
  )
}
