import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { AuthScreen } from '@app/_components/auth-screen'
import { env } from '@/env'
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password'
import { getSessionUser } from '@/lib/auth/session'
import { isSetupComplete } from '@/lib/auth/setup'
import { findRedeemableToken, type RedeemableInvite } from '@/lib/invites/redeem'

/**
 * `/signup`, gated by decision #25. With `ALLOW_OPEN_REGISTRATION=false` — the default — this
 * route does not exist unless the caller holds a redeemable invite: a used, expired, revoked, or
 * absent token is a 404, not a 403, so the page cannot be used to test whether an invite is live.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Create your account · enclave' }

const INVALID_SUBMISSION = 'Enter a valid email and a password of at least 12 characters.'

interface SignupPageProps {
  searchParams: Promise<{ t?: string; error?: string }>
}

/** `null` here means "no invite, and open registration allows that"; anything else 404s. */
async function resolveInvite(rawToken: string | undefined): Promise<RedeemableInvite | null> {
  if (rawToken === undefined || rawToken === '') {
    if (env.ALLOW_OPEN_REGISTRATION) return null
    notFound()
  }

  const invite = await findRedeemableToken(rawToken)
  if (invite === null) notFound()
  return invite
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  // Before the first admin exists there is nobody to have issued an invite.
  if (!(await isSetupComplete())) redirect('/setup')
  if ((await getSessionUser()) !== null) redirect('/dashboard')

  const { t: rawToken, error } = await searchParams
  const invite = await resolveInvite(rawToken)

  return (
    <AuthScreen
      heading="Create your account"
      caption={captionFor(invite)}
      action="/api/auth/signup"
      submitLabel="Create account"
      passwordAutoComplete="new-password"
      passwordHint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
      errorMessage={error === undefined ? null : INVALID_SUBMISSION}
      hiddenFields={rawToken === undefined ? {} : { inviteToken: rawToken }}
    />
  )
}

function captionFor(invite: RedeemableInvite | null): string {
  if (invite === null) return 'This instance accepts new accounts from anyone.'
  if (invite.email === null) return 'This invite accepts any email address.'
  return `This invite was issued for ${invite.email}.`
}
