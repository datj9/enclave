import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AuthScreen } from '@app/_components/auth-screen'
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password'
import { GENERIC_RESET_FAILURE } from '@/lib/auth/reset-password'
import { isSetupComplete } from '@/lib/auth/setup'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Reset password · enclave' }

interface ResetPasswordPageProps {
  searchParams: Promise<{ t?: string; error?: string }>
}

function errorMessageFor(error: string | undefined): string | null {
  if (error === 'password') return 'Enter a password of at least 12 characters.'
  if (error === 'invalid') return GENERIC_RESET_FAILURE
  return null
}

export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  if (!(await isSetupComplete())) redirect('/setup')

  const { t: rawToken, error } = await searchParams

  return (
    <AuthScreen
      heading="Choose a new password"
      caption="This link is single-use."
      action="/api/auth/reset-password"
      submitLabel="Reset password"
      showEmail={false}
      showPassword
      passwordAutoComplete="new-password"
      passwordHint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      hiddenFields={rawToken === undefined ? {} : { token: rawToken }}
      errorMessage={errorMessageFor(error)}
      footer={<a href="/signin">Back to sign in</a>}
    />
  )
}
