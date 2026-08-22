import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthScreen } from '@app/_components/auth-screen'
import { GENERIC_FORGOT_PASSWORD_SUCCESS } from '@/lib/auth/forgot-password'
import { getSessionUser } from '@/lib/auth/session'
import { isSetupComplete } from '@/lib/auth/setup'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Forgot password · enclave' }

interface ForgotPasswordPageProps {
  searchParams: Promise<{ error?: string; sent?: string }>
}

export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  if (!(await isSetupComplete())) redirect('/setup')
  if ((await getSessionUser()) !== null) redirect('/dashboard')

  const { error, sent } = await searchParams

  return (
    <AuthScreen
      heading="Forgot password"
      caption="Enter the email for this instance."
      action="/api/auth/forgot-password"
      submitLabel="Send reset link"
      showPassword={false}
      errorMessage={error === undefined ? null : 'Enter a valid email address.'}
      successMessage={sent === '1' ? GENERIC_FORGOT_PASSWORD_SUCCESS : null}
      footer={
        <p>
          <a href="/signin">Back to sign in</a>
        </p>
      }
    />
  )
}
