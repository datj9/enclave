import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AuthScreen } from '@app/_components/auth-screen'
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password'
import { isSetupComplete } from '@/lib/auth/setup'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'First-run setup · enclave' }

interface SetupPageProps {
  searchParams: Promise<{ error?: string }>
}

export default async function SetupPage({ searchParams }: SetupPageProps) {
  // Single-use page: once any user exists this route is gone, not merely forbidden (§2 #35).
  if (await isSetupComplete()) notFound()

  const { error } = await searchParams

  return (
    <AuthScreen
      heading="Create the administrator"
      caption="This runs once. After this account exists, this page stops responding."
      action="/api/setup"
      submitLabel="Create administrator"
      passwordAutoComplete="new-password"
      passwordHint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      errorMessage={
        error === undefined ? null : 'Enter a valid email and a password of at least 12 characters.'
      }
    />
  )
}
