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
 * Verifies a password against a stored hash. A deactivated user fails here rather than getting
 * a session that later requests reject, so the failure surface stays in one place.
 */
export async function authenticateWithPassword(credentials: Credentials): Promise<SigninOutcome> {
  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, credentials.email))
    .limit(1)

  if (user === undefined) return { ok: false }
  if (!(await verifyPassword(user.passwordHash, credentials.password))) return { ok: false }
  if (!user.isActive) return { ok: false }

  return { ok: true, userId: user.id }
}
