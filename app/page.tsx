import { redirect } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { isSetupComplete } from '@/lib/auth/setup'

export const dynamic = 'force-dynamic'

/** Placeholder. S12 replaces this route with the marketing landing page. */
export default async function RootPage() {
  if (!(await isSetupComplete())) redirect('/setup')
  redirect((await getSessionUser()) === null ? '/signin' : '/dashboard')
}
