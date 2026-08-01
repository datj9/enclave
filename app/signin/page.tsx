import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthScreen } from '@app/_components/auth-screen'
import { GENERIC_SIGNIN_FAILURE } from '@/lib/auth/credentials'
import { getSessionUser } from '@/lib/auth/session'
import { isSetupComplete } from '@/lib/auth/setup'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Sign in · enclave' }

interface SigninPageProps {
  searchParams: Promise<{ error?: string }>
}

export default async function SigninPage({ searchParams }: SigninPageProps) {
  if (!(await isSetupComplete())) redirect('/setup')
  if ((await getSessionUser()) !== null) redirect('/dashboard')

  const { error } = await searchParams

  return (
    <AuthScreen
      heading="Sign in"
      caption="Enter the credentials for this instance."
      action="/api/auth/signin"
      submitLabel="Sign in"
      passwordAutoComplete="current-password"
      errorMessage={error === undefined ? null : `${GENERIC_SIGNIN_FAILURE}.`}
    />
  )
}
