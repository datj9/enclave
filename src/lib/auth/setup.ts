import { sql as raw } from 'drizzle-orm'
import { db } from '@/db'
import { users } from '@/db/schema'
import { HttpError } from '@/lib/http'
import { hashPassword } from './password'

/**
 * Arbitrary but fixed advisory-lock key, so concurrent /setup submits serialize on it. Without
 * it, both transactions read `count(users) = 0` under READ COMMITTED and both insert.
 */
const SETUP_LOCK_KEY = 8_531_207

export async function isSetupComplete(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1)
  return row !== undefined
}

export interface FirstAdminInput {
  readonly email: string
  readonly password: string
}

/**
 * Creates the one and only first admin. Hashing happens before the transaction so the lock is
 * held for a query, not for argon2's ~50 ms of deliberate work.
 */
export async function createFirstAdmin(input: FirstAdminInput): Promise<{ id: string }> {
  const passwordHash = await hashPassword(input.password)

  return db.transaction(async (transaction) => {
    await transaction.execute(raw`select pg_advisory_xact_lock(${SETUP_LOCK_KEY})`)

    const [existing] = await transaction.select({ id: users.id }).from(users).limit(1)
    if (existing !== undefined) {
      throw new HttpError('VALIDATION_FAILED', 'Setup has already been completed', { status: 409 })
    }

    const [created] = await transaction
      .insert(users)
      .values({ email: input.email, passwordHash, role: 'admin', isActive: true })
      .returning({ id: users.id })

    if (created === undefined) {
      throw new HttpError('INTERNAL_ERROR', 'Could not create the administrator account')
    }
    return created
  })
}
