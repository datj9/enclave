import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import { users } from '@/db/schema'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from './password'

export const credentialsSchema = z.object({
  // Normalise before validating: a pasted address often carries a trailing space, and the
  // stored column is citext, so the lowercase form is what the query should look for.
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
})

export type Credentials = z.infer<typeof credentialsSchema>

/** Deliberately the only sign-in failure message: it distinguishes nothing (§8, A.9.4.2). */
export const GENERIC_SIGNIN_FAILURE = 'Email or password is incorrect'

export type SigninOutcome = { readonly ok: true; readonly userId: string } | { readonly ok: false }

/**
 * A real argon2id hash of a random secret that was discarded when it was generated, at the same
 * parameters as `ARGON2_OPTIONS` (a unit test holds the two together). Verifying against it costs
 * what verifying a real account costs, and it can never match. A constant rather than computed at
 * runtime, so the first failed sign-in after a restart does not pay for an extra hash and stand
 * out by its timing.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$AS8wz9o5lEwsd5piKk4yTQ$mNjtLF1yg+XtZJFb6xP6SkgmFOwMpdNkbZ2QyjKJI3A'

/**
 * Verifies a password against a stored hash. A deactivated user fails here rather than getting
 * a session that later requests reject, so the failure surface stays in one place.
 *
 * Every branch pays for exactly one argon2 verification — against the dummy hash when there is
 * no usable stored hash (unknown email, OIDC-only account) — so response time does not reveal
 * whether an address has an account (§8, A.9.4.2).
 */
export async function authenticateWithPassword(credentials: Credentials): Promise<SigninOutcome> {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, credentials.email))
    .limit(1)

  const storedHash = user?.passwordHash ?? null
  if (user === undefined || storedHash === null || storedHash === '') {
    await verifyPassword(DUMMY_PASSWORD_HASH, credentials.password)
    return { ok: false }
  }

  if (!(await verifyPassword(storedHash, credentials.password))) return { ok: false }
  if (!user.isActive) return { ok: false }

  return { ok: true, userId: user.id }
}
