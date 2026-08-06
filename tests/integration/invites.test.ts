import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db, pingDatabase } from '@/db'
import { auditLog } from '@/db/schema/audit-log'
import { invites } from '@/db/schema/invites'
import { users } from '@/db/schema/users'
import { HttpError } from '@/lib/http'
import { createInvite, listInvites, revokeInvite } from '@/lib/invites/manage'
import { registerMember } from '@/lib/invites/register'
import { requireRedeemableToken } from '@/lib/invites/redeem'
import { hashInviteToken } from '@/lib/invites/tokens'
import { databaseNowEpoch, epochToDate } from '@/lib/shares/clock'

/**
 * S10's single-use guarantee against the real Postgres the lock lives in. A mock cannot prove the
 * thing this slice is about: that two simultaneous redemptions of one token produce exactly one
 * member and one 410.
 */

const databaseReady = await pingDatabase().then(
  () => true,
  () => false,
)

if (!databaseReady) {
  console.warn('[enclave] skipping tests/integration/invites: no database on DATABASE_URL.')
}

const ADMIN_EMAIL = 'invite-admin@example.test'
const DAVE_EMAIL = 'invite-dave@example.test'
const EVE_EMAIL = 'invite-eve@example.test'
const RACER_EMAIL = 'invite-racer@example.test'
const PASSWORD = 'correct-horse-battery-staple'

const TEST_EMAILS = [ADMIN_EMAIL, DAVE_EMAIL, EVE_EMAIL, RACER_EMAIL]

let adminId = ''

/**
 * `audit_log` rows are deliberately left behind: the table is append-only (A.12.4.1) and carries
 * no foreign key to `users`, so history survives its actors — which is the point.
 */
async function removeTestRows(): Promise<void> {
  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, TEST_EMAILS))
  const ids = testUsers.map((user) => user.id)

  if (ids.length > 0) await db.delete(invites).where(inArray(invites.createdBy, ids))
  await db.delete(users).where(inArray(users.email, TEST_EMAILS))
}

/** Invites point at their redeemer, so that reference goes before the member row does. */
async function removeMembers(emails: readonly string[]): Promise<void> {
  const members = await db.select({ id: users.id }).from(users).where(inArray(users.email, [...emails]))
  const ids = members.map((member) => member.id)

  if (ids.length > 0) {
    await db.update(invites).set({ usedBy: null }).where(inArray(invites.usedBy, ids))
    await db.delete(users).where(inArray(users.id, ids))
  }
}

async function createAdmin(): Promise<string> {
  const [admin] = await db
    .insert(users)
    .values({ email: ADMIN_EMAIL, passwordHash: null, role: 'admin', isActive: true })
    .returning({ id: users.id })

  if (admin === undefined) throw new Error('could not create the invite test admin')
  return admin.id
}

async function statusOfToken(token: string): Promise<HttpError | null> {
  try {
    await requireRedeemableToken(token)
    return null
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
}

async function expireInvite(inviteId: string): Promise<void> {
  await db
    .update(invites)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(invites.id, inviteId))
}

/** Ages a row on the database clock itself, independent of whatever the Node clock reads. */
async function ageInviteOnDatabaseClock(inviteId: string): Promise<void> {
  await db
    .update(invites)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(invites.id, inviteId))
}

async function currentDatabaseNow(): Promise<Date> {
  const rows = await db.execute<{ databaseNow: string | number }>(
    sql`select ${databaseNowEpoch} as "databaseNow"`,
  )
  const [row] = rows
  if (row === undefined) throw new Error('could not read the database clock')
  return epochToDate(row.databaseNow)
}

/** The audit log is append-only, so this reads rather than truncates between cases. */
async function auditActionsFor(userId: string): Promise<readonly string[]> {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.actorUserId, userId))
    .orderBy(auditLog.id)

  return rows.map((row) => row.action)
}

describe.skipIf(!databaseReady)('invite redemption', () => {
  beforeAll(async () => {
    await removeTestRows()
    adminId = await createAdmin()
  })

  afterAll(removeTestRows)

  beforeEach(async () => {
    await removeMembers([DAVE_EMAIL, EVE_EMAIL, RACER_EMAIL])
  })

  it('stores only a digest — the plaintext is not recoverable from the row', async () => {
    const created = await createInvite({
      createdBy: adminId,
      email: DAVE_EMAIL,
      expiresInHours: 72,
    })

    const [row] = await db
      .select({ tokenHash: invites.tokenHash })
      .from(invites)
      .where(eq(invites.id, created.inviteId))

    expect(row?.tokenHash.equals(hashInviteToken(created.token))).toBe(true)
    expect(row?.tokenHash.toString('utf8')).not.toContain(created.token)
  })

  it('writes a user.invite audit row that does not carry the token', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 1 })

    const rows = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, adminId))
      .orderBy(auditLog.id)

    const invited = rows.filter((row) => row.action === 'user.invite')
    expect(invited.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(invited)).not.toContain(created.token)
    expect(invited.at(-1)?.metadata).toMatchObject({ inviteId: created.inviteId })
  })

  it('creates the member, marks the invite used, and audits user.create', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })

    const member = await registerMember({
      email: DAVE_EMAIL,
      password: PASSWORD,
      inviteToken: created.token,
    })

    const [dave] = await db
      .select({ role: users.role, isActive: users.isActive, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, member.id))
    expect(dave?.role).toBe('member')
    expect(dave?.isActive).toBe(true)
    expect(dave?.passwordHash).not.toBeNull()

    const [row] = await db
      .select({ usedAt: invites.usedAt, usedBy: invites.usedBy })
      .from(invites)
      .where(eq(invites.id, created.inviteId))
    expect(row?.usedAt).not.toBeNull()
    expect(row?.usedBy).toBe(member.id)

    expect(await auditActionsFor(member.id)).toContain('user.create')
  })

  it('410s a second redemption of the same token', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })
    await registerMember({ email: DAVE_EMAIL, password: PASSWORD, inviteToken: created.token })

    const replay = registerMember({ email: EVE_EMAIL, password: PASSWORD, inviteToken: created.token })

    await expect(replay).rejects.toMatchObject({
      status: 410,
      code: 'VALIDATION_FAILED',
      message: 'This invite has already been used',
    })
    const eve = await db.select({ id: users.id }).from(users).where(eq(users.email, EVE_EMAIL))
    expect(eve).toHaveLength(0)
  })

  it('410s an expired invite', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 1 })
    await expireInvite(created.inviteId)

    await expect(
      registerMember({ email: DAVE_EMAIL, password: PASSWORD, inviteToken: created.token }),
    ).rejects.toMatchObject({ status: 410, message: 'This invite has expired' })
  })

  it('410s a revoked invite', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })
    expect(await revokeInvite(created.inviteId)).toBe(true)

    await expect(
      registerMember({ email: DAVE_EMAIL, password: PASSWORD, inviteToken: created.token }),
    ).rejects.toMatchObject({ status: 410, message: 'This invite has been revoked' })
  })

  it('404s an unknown token — the id space is not probeable', async () => {
    const error = await statusOfToken('inv_wSqTsPFPWLTHIsGWkUgsAFCwmCLnGRQvJyEPqDmYaAg')

    expect([error?.status, error?.code]).toEqual([404, 'NOT_FOUND'])
  })

  it('refuses an email the invite was not issued for', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })

    await expect(
      registerMember({ email: EVE_EMAIL, password: PASSWORD, inviteToken: created.token }),
    ).rejects.toMatchObject({ status: 422 })

    const [row] = await db
      .select({ usedAt: invites.usedAt })
      .from(invites)
      .where(eq(invites.id, created.inviteId))
    expect(row?.usedAt).toBeNull()
  })

  it('accepts any address on a link-only invite', async () => {
    const created = await createInvite({ createdBy: adminId, email: null, expiresInHours: 72 })

    const member = await registerMember({
      email: EVE_EMAIL,
      password: PASSWORD,
      inviteToken: created.token,
    })

    expect(member.inviteId).toBe(created.inviteId)
  })

  it('refuses registration outright without a token while the flag is false', async () => {
    await expect(registerMember({ email: EVE_EMAIL, password: PASSWORD })).rejects.toMatchObject({
      status: 404,
      message: 'This instance is invite-only',
    })
  })

  /**
   * The acceptance criterion the advisory lock exists for. Both calls start before either has
   * written `used_at`, so without serialisation both would read `used_at is null` and insert.
   */
  it('yields exactly one user and one 410 when one invite is redeemed twice at once', async () => {
    const created = await createInvite({ createdBy: adminId, email: null, expiresInHours: 72 })

    const outcomes = await Promise.allSettled([
      registerMember({ email: RACER_EMAIL, password: PASSWORD, inviteToken: created.token }),
      registerMember({ email: EVE_EMAIL, password: PASSWORD, inviteToken: created.token }),
    ])

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect([fulfilled.length, rejected.length]).toEqual([1, 1])

    expect(rejected[0]?.status === 'rejected' ? rejected[0].reason : null).toMatchObject({
      status: 410,
    })

    const survivors = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.email, [RACER_EMAIL, EVE_EMAIL]))
    expect(survivors).toHaveLength(1)
  })

  it('lists invites with their status and never a token', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })

    const listed = await listInvites()
    const found = listed.find((invite) => invite.id === created.inviteId)

    expect(found?.status).toBe('outstanding')
    expect(JSON.stringify(listed)).not.toContain(created.token)
  })

  it('mints expiresAt from the database clock, within a second of now() + the requested TTL', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 1 })

    const databaseNow = await currentDatabaseNow()
    const expected = databaseNow.getTime() + 60 * 60 * 1000
    const actual = new Date(created.expiresAt).getTime()

    expect(Math.abs(actual - expected)).toBeLessThan(1000)
  })

  it('mints expiresAt from the database clock even when the Node clock is skewed', async () => {
    const realNow = Date.now.bind(Date)
    const skewed = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 60 * 60 * 1000)

    try {
      const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 1 })
      const databaseNow = await currentDatabaseNow()
      const expected = databaseNow.getTime() + 60 * 60 * 1000
      const actual = new Date(created.expiresAt).getTime()

      expect(Math.abs(actual - expected)).toBeLessThan(1000)
    } finally {
      skewed.mockRestore()
    }
  })

  it('reports expired from listInvites once the database clock has passed expiresAt', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })
    await ageInviteOnDatabaseClock(created.inviteId)

    const listed = await listInvites()
    const found = listed.find((invite) => invite.id === created.inviteId)

    expect(found?.status).toBe('expired')
  })

  it('agrees with the redemption gate: a database-clock-expired invite is refused with 410', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 72 })
    await ageInviteOnDatabaseClock(created.inviteId)

    const listed = await listInvites()
    const found = listed.find((invite) => invite.id === created.inviteId)
    expect(found?.status).toBe('expired')

    await expect(requireRedeemableToken(created.token)).rejects.toMatchObject({
      status: 410,
      message: 'This invite has expired',
    })
  })

  it('reports outstanding from the database clock even when the Node clock is skewed forward', async () => {
    const created = await createInvite({ createdBy: adminId, email: DAVE_EMAIL, expiresInHours: 1 })

    const realNow = Date.now.bind(Date)
    const skewed = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 60 * 60 * 1000)

    try {
      const listed = await listInvites()
      const found = listed.find((invite) => invite.id === created.inviteId)

      expect(found?.status).toBe('outstanding')
    } finally {
      skewed.mockRestore()
    }
  })
})
