import { redirect } from 'next/navigation'
import { cache } from 'react'

import { getSessionUser, type SessionUser } from '@/lib/auth/session'

/**
 * Per-request memo of `getSessionUser`, so a segment layout that gates on the session and the page
 * below it that needs the user share one cookie verify and one users-table read.
 */
export const getRequestSessionUser = cache(getSessionUser)

/**
 * The signed-out redirect for a segment that has a `loading.tsx`.
 *
 * `loading.tsx` wraps the *page* in a Suspense boundary, so a `redirect()` thrown by the page is
 * streamed after the skeleton and performed client-side once the document has loaded — a signed-out
 * visitor saw a flash of skeleton, then a second navigation. Calling this from the segment's
 * `layout.tsx`, which renders outside that boundary, keeps it a real HTTP redirect.
 */
export async function requireSessionUser(): Promise<SessionUser> {
  const sessionUser = await getRequestSessionUser()
  if (sessionUser === null) redirect('/signin')
  return sessionUser
}
