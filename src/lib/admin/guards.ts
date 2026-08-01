import { requireSessionUser } from '@/lib/api/guards'
import { HttpError } from '@/lib/http'
import type { SessionUser } from '@/lib/auth/session'

/**
 * The gate on every admin surface. Session-only on purpose: API tokens are member-scoped by
 * design (§5.3), so an admin's leaked token can never reach the console it never needed.
 *
 * A non-admin gets 403, not 404 — the console's existence is not a secret, and A.9.4.1 is about
 * what an account may do, not about hiding the route. What an admin still cannot do is read a
 * private artifact: that stays `canRead` branch 5 (§5.1, decision #26), and nothing here widens it.
 */
export async function requireAdminUser(): Promise<SessionUser> {
  const sessionUser = await requireSessionUser()
  if (sessionUser.role !== 'admin') {
    throw new HttpError('FORBIDDEN', 'This action requires an administrator')
  }
  return sessionUser
}
