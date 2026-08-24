import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db, pingDatabase } from '@/db'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { prunePasswordResetTokens } from '@/jobs/prune-password-resets'
import { mintPasswordResetToken } from '@/lib/auth/password-reset-tokens'

/**
 * Retention for spent reset rows against real Postgres. The parts a mock cannot prove: that the
 * window is judged on the database clock, that a row still usable is never touched, and that a
 * consumed row does eventually leave a table nothing else deletes from.
 */

/**
 * Its own owner, not `createTestOwner`'s shared one: vitest runs test files in parallel and that
 * helper deletes by a single fixed email, so two suites would tear down each other's rows.
 */
const OWNER_EMAIL = 'integration-pwreset-prune@example.test'

const RETENTION_DAYS = 7
const WITHIN_WINDOW_DAYS = 6
const PAST_WINDOW_DAYS = 8

const databaseReady = await pingDatabase().then(
  () => true,
  () => false,
)

if (!databaseReady) {
  console.warn(
    '[enclave] skipping tests/integration/password-reset-prune: no database on DATABASE_URL.',
  )
}

let ownerId = ''

interface SeedRow {
  readonly ageDays: number
  readonly isUsed: boolean
  readonly isExpired: boolean
}

async function seedRow(row: SeedRow): Promise<string> {
  const createdAt = sql`now() - make_interval(hours => ${row.ageDays * 24})`
  const [inserted] = await db
    .insert(passwordResetTokens)
    .values({
      userId: ownerId,
      tokenHash: mintPasswordResetToken().tokenHash,
      createdAt,
      expiresAt: row.isExpired ? sql`now() - interval '1 second'` : sql`now() + interval '1 hour'`,
      usedAt: row.isUsed ? createdAt : null,
    })
    .returning({ id: passwordResetTokens.id })

  if (inserted === undefined) throw new Error('failed to seed a password reset row')
  return inserted.id
}

async function survivingIds(): Promise<string[]> {
  const rows = await db
    .select({ id: passwordResetTokens.id })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.userId, ownerId))
  return rows.map((row) => row.id)
}

describe.skipIf(!databaseReady)('prunePasswordResetTokens', () => {
  beforeAll(async () => {
    // Same pre-delete as `createTestOwner`: an interrupted run leaves the unique email behind.
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, OWNER_EMAIL))
    if (existing !== undefined) {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, existing.id))
      await db.delete(users).where(eq(users.id, existing.id))
    }

    const [owner] = await db
      .insert(users)
      .values({ email: OWNER_EMAIL, passwordHash: 'unused', role: 'member', isActive: true })
      .returning({ id: users.id })

    if (owner === undefined) throw new Error('could not create the prune test owner')
    ownerId = owner.id
  })

  afterAll(async () => {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, ownerId))
    await db.delete(users).where(eq(users.id, ownerId))
  })

  beforeEach(async () => {
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, ownerId))
  })

  it('deletes a used row past the retention window', async () => {
    const stale = await seedRow({ ageDays: PAST_WINDOW_DAYS, isUsed: true, isExpired: true })

    const result = await prunePasswordResetTokens(RETENTION_DAYS)

    expect(result.retentionDays).toBe(RETENTION_DAYS)
    expect(result.prunedRowCount).toBe(1)
    expect(await survivingIds()).not.toContain(stale)
  })

  it('deletes an expired unused row past the window without waiting for another request', async () => {
    const stale = await seedRow({ ageDays: PAST_WINDOW_DAYS, isUsed: false, isExpired: true })

    await prunePasswordResetTokens(RETENTION_DAYS)

    expect(await survivingIds()).not.toContain(stale)
  })

  it('keeps a used row that is still inside the window', async () => {
    const recent = await seedRow({ ageDays: WITHIN_WINDOW_DAYS, isUsed: true, isExpired: true })

    const result = await prunePasswordResetTokens(RETENTION_DAYS)

    expect(result.prunedRowCount).toBe(0)
    expect(await survivingIds()).toEqual([recent])
  })

  it('keeps an outstanding row no matter how old it is', async () => {
    const outstanding = await seedRow({
      ageDays: PAST_WINDOW_DAYS,
      isUsed: false,
      isExpired: false,
    })

    const result = await prunePasswordResetTokens(RETENTION_DAYS)

    expect(result.prunedRowCount).toBe(0)
    expect(await survivingIds()).toEqual([outstanding])
  })

  it('leaves nothing to do on a second run over the same rows', async () => {
    await seedRow({ ageDays: PAST_WINDOW_DAYS, isUsed: true, isExpired: true })

    await prunePasswordResetTokens(RETENTION_DAYS)
    const second = await prunePasswordResetTokens(RETENTION_DAYS)

    expect(second.prunedRowCount).toBe(0)
  })

  it('touches only the rows it should when the table holds a mix', async () => {
    const stale = await seedRow({ ageDays: PAST_WINDOW_DAYS, isUsed: true, isExpired: true })
    const recent = await seedRow({ ageDays: WITHIN_WINDOW_DAYS, isUsed: true, isExpired: true })
    const outstanding = await seedRow({ ageDays: 0, isUsed: false, isExpired: false })

    const result = await prunePasswordResetTokens(RETENTION_DAYS)

    expect(result.prunedRowCount).toBe(1)
    const surviving = await survivingIds()
    expect(surviving).toHaveLength(2)
    expect(surviving).toContain(recent)
    expect(surviving).toContain(outstanding)
    expect(surviving).not.toContain(stale)
  })

  it('does not touch a fresh row belonging to another user', async () => {
    const otherEmail = 'integration-pwreset-prune-other@example.test'
    await db.delete(users).where(inArray(users.email, [otherEmail]))
    const [other] = await db
      .insert(users)
      .values({ email: otherEmail, passwordHash: 'unused', role: 'member', isActive: true })
      .returning({ id: users.id })
    if (other === undefined) throw new Error('could not create the second prune test owner')

    try {
      const [fresh] = await db
        .insert(passwordResetTokens)
        .values({
          userId: other.id,
          tokenHash: mintPasswordResetToken().tokenHash,
          expiresAt: sql`now() + interval '1 hour'`,
        })
        .returning({ id: passwordResetTokens.id })

      await prunePasswordResetTokens(RETENTION_DAYS)

      const remaining = await db
        .select({ id: passwordResetTokens.id })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, other.id))
      expect(remaining.map((row) => row.id)).toEqual([fresh!.id])
    } finally {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, other.id))
      await db.delete(users).where(eq(users.id, other.id))
    }
  })
})
