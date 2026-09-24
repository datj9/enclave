import type { ReactNode } from 'react'

import { requireSessionUser } from '@app/_components/session-gate'

/**
 * Gates the segment on a session *outside* the Suspense boundary that `loading.tsx` puts around the
 * page, so a signed-out visitor gets a real redirect to /signin instead of a skeleton followed by a
 * client-side one. See app/_components/session-gate.ts.
 */
export default async function TrashLayout({ children }: { readonly children: ReactNode }) {
  await requireSessionUser()
  return children
}
