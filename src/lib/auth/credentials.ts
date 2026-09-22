import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/db'
import { users } from '@/db/schema'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword, verifyPassword } from './password'

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
 * A real argon2id hash of a random secret nobody holds, computed once per process with the same
 * parameters as every stored hash. Verifying against it costs what verifying a real account
 * costs, and it can never match.
 */
let dummyHash: Promise<string> | undefined

function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64')).catch((error: unknown) => {
    // Do not cache a failure: the next sign-in should try again rather than skip the work.
    dummyHash = undefined
    throw error
  })
  return dummyHash
}

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
    await verifyPassword(await dummyPasswordHash(), credentials.password)
    return { ok: false }
  }

  if (!(await verifyPassword(storedHash, credentials.password))) return { ok: false }
  if (!user.isActive) return { ok: false }

  return { ok: true, userId: user.id }
}
