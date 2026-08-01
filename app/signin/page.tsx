import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthScreen } from '@app/_components/auth-screen'
import { OidcSignin } from '@app/_components/oidc-signin'
import { GENERIC_SIGNIN_FAILURE } from '@/lib/auth/credentials'
import { isOidcEnabled } from '@/lib/auth/oidc'
import { getSessionUser } from '@/lib/auth/session'
import { isSetupComplete } from '@/lib/auth/setup'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Sign in · enclave' }

const OIDC_FAILURE = 'Your identity provider did not complete the sign-in.'

interface SigninPageProps {
  searchParams: Promise<{ error?: string }>
}

function errorMessageFor(error: string | undefined): string | null {
  if (error === undefined) return null
  return error === 'oidc' ? OIDC_FAILURE : `${GENERIC_SIGNIN_FAILURE}.`
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
      errorMessage={errorMessageFor(error)}
      alternative={isOidcEnabled() ? <OidcSignin /> : null}
    />
  )
}
