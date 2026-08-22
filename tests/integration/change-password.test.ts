import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db, pingDatabase } from '@/db'
import { auditLog, type AuditAction } from '@/db/schema/audit-log'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { mintPasswordResetToken } from '@/lib/auth/password-reset-tokens'
import { createSessionCookie } from '@/lib/auth/session'
import type * as SessionModule from '@/lib/auth/session'
import { isSessionInvalidatedByPasswordChange } from '@/lib/auth/session-freshness'
import { resetRateLimits } from '@/lib/rate-limit'

const ACTIVE_EMAIL = 'pwchange-active@example.test'
const OIDC_EMAIL = 'pwchange-oidc@example.test'
const SECOND_EMAIL = 'pwchange-second@example.test'

const TEST_EMAILS = [ACTIVE_EMAIL, OIDC_EMAIL, SECOND_EMAIL]

const OLD_PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'new-correct-horse'

const mocks = vi.hoisted(() => ({
  sessionUser: null as {
    id: string
    email: string
    role: 'admin' | 'member'
    isActive: boolean
  } | null,
}))

vi.mock('@/lib/auth/session', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionModule>()
  return {
    ...actual,
    getSessionUser: () => Promise.resolve(mocks.sessionUser),
  }
})

const { POST: changePasswordRoute } = await import('@app/api/auth/change-password/route')

const databaseReady = await pingDatabase().then(
  () => true,
  () => false,
)

if (!databaseReady) {
  console.warn('[enclave] skipping tests/integration/change-password: no database on DATABASE_URL.')
}

let activeUserId = ''
let oidcUserId = ''
let secondUserId = ''

function jsonPost(body: unknown, forwardedFor = '198.51.100.20'): Request {
  return new Request('http://localhost:3000/api/auth/change-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    body: JSON.stringify(body),
  })
}

function formPost(fields: Record<string, string>, forwardedFor = '198.51.100.21'): Request {
  return new Request('http://localhost:3000/api/auth/change-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': forwardedFor,
    },
    body: new URLSearchParams(fields).toString(),
  })
}

async function removeTestRows(): Promise<void> {
  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, TEST_EMAILS))
  const ids = testUsers.map((user) => user.id)

  if (ids.length > 0) {
    await db.delete(passwordResetTokens).where(inArray(passwordResetTokens.userId, ids))
    await db.delete(users).where(inArray(users.email, TEST_EMAILS))
  }
}

async function seedToken(userId: string): Promise<{ plaintext: string; tokenId: string }> {
  const minted = mintPasswordResetToken()
  const [row] = await db
    .insert(passwordResetTokens)
    .values({
      userId,
      tokenHash: minted.tokenHash,
      expiresAt: sql`now() + interval '1 hour'`,
    })
    .returning({ id: passwordResetTokens.id })

  if (row === undefined) throw new Error('failed to seed token')
  return { plaintext: minted.plaintext, tokenId: row.id }
}

async function latestAuditFor(
  userId: string,
  action: AuditAction,
): Promise<{ action: string; metadata: Record<string, unknown> | null } | undefined> {
  const rows = await db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, userId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.id))
    .limit(1)

  return rows[0]
}

describe.skipIf(!databaseReady)('POST /api/auth/change-password', () => {
  beforeAll(async () => {
    await removeTestRows()

    const inserted = await db
      .insert(users)
      .values([
        {
          email: ACTIVE_EMAIL,
          passwordHash: await hashPassword(OLD_PASSWORD),
          role: 'member',
          isActive: true,
        },
        { email: OIDC_EMAIL, passwordHash: null, role: 'member', isActive: true },
        {
          email: SECOND_EMAIL,
          passwordHash: await hashPassword(OLD_PASSWORD),
          role: 'member',
          isActive: true,
        },
      ])
      .returning({ id: users.id, email: users.email })

    for (const user of inserted) {
      if (user.email === ACTIVE_EMAIL) activeUserId = user.id
      else if (user.email === OIDC_EMAIL) oidcUserId = user.id
      else if (user.email === SECOND_EMAIL) secondUserId = user.id
    }
  })

  afterAll(removeTestRows)

  beforeEach(async () => {
    resetRateLimits()
    mocks.sessionUser = {
      id: activeUserId,
      email: ACTIVE_EMAIL,
      role: 'member',
      isActive: true,
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(OLD_PASSWORD), passwordChangedAt: null })
      .where(eq(users.id, activeUserId))
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, activeUserId))
  })

  it('returns 401 Sign in to continue without a session', async () => {
    mocks.sessionUser = null
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('Sign in to continue')
  })

  it('redirects an unauthenticated form POST to /signin', async () => {
    mocks.sessionUser = null
    const response = await changePasswordRoute(
      formPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/signin')
  })

  it('returns 403 for a OIDC-only user and does not set a password', async () => {
    mocks.sessionUser = { id: oidcUserId, email: OIDC_EMAIL, role: 'member', isActive: true }
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(403)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('This account has no password')
    expect(response.headers.get('set-cookie')).toBeFalsy()

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, oidcUserId))
    expect(user?.passwordHash).toBeNull()
  })

  it('audits auth.password_change_failed with reason no_password for a OIDC-only user', async () => {
    mocks.sessionUser = { id: oidcUserId, email: OIDC_EMAIL, role: 'member', isActive: true }
    await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    const audit = await latestAuditFor(oidcUserId, 'auth.password_change_failed')
    expect(audit).toBeTruthy()
    expect(audit!.action).toBe('auth.password_change_failed')
    expect(audit!.metadata).toMatchObject({ reason: 'no_password' })
    expect(JSON.stringify(audit!.metadata)).not.toContain(OLD_PASSWORD)
    expect(JSON.stringify(audit!.metadata)).not.toContain(NEW_PASSWORD)
  })

  it('returns 401 when the current password is wrong and does not rotate the hash', async () => {
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: 'wrong-horse-battery',
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('Current password is incorrect')

    const [user] = await db
      .select({ passwordHash: users.passwordHash, passwordChangedAt: users.passwordChangedAt })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(await verifyPassword(user!.passwordHash, OLD_PASSWORD)).toBe(true)
    expect(user!.passwordChangedAt).toBeNull()
  })

  it('audits auth.password_change_failed with reason wrong_current', async () => {
    await changePasswordRoute(
      jsonPost({
        currentPassword: 'wrong-horse-battery',
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    const audit = await latestAuditFor(activeUserId, 'auth.password_change_failed')
    expect(audit).toBeTruthy()
    expect(audit!.action).toBe('auth.password_change_failed')
    expect(audit!.metadata).toMatchObject({ reason: 'wrong_current' })
  })

  it('returns 422 when the new password equals the current password', async () => {
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: OLD_PASSWORD,
        confirmNewPassword: OLD_PASSWORD,
      }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('Choose a different password')

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(await verifyPassword(user!.passwordHash, OLD_PASSWORD)).toBe(true)
  })

  it('audits auth.password_change_failed with reason same_password', async () => {
    await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: OLD_PASSWORD,
        confirmNewPassword: OLD_PASSWORD,
      }),
    )

    const audit = await latestAuditFor(activeUserId, 'auth.password_change_failed')
    expect(audit).toBeTruthy()
    expect(audit!.action).toBe('auth.password_change_failed')
    expect(audit!.metadata).toMatchObject({ reason: 'same_password' })
  })

  it('returns 422 when confirm does not match and does not rotate the hash', async () => {
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: 'other-correct-horse',
      }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('New password and confirmation do not match')

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(await verifyPassword(user!.passwordHash, OLD_PASSWORD)).toBe(true)
  })

  it('returns 422 for a new password shorter than 12 characters', async () => {
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: 'short',
        confirmNewPassword: 'short',
      }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('Enter a password of at least 12 characters')
  })

  it('audits auth.password_change_failed with reason malformed for a schema failure', async () => {
    await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: 'short',
        confirmNewPassword: 'short',
      }),
    )

    const audit = await latestAuditFor(activeUserId, 'auth.password_change_failed')
    expect(audit).toBeTruthy()
    expect(audit!.action).toBe('auth.password_change_failed')
    expect(audit!.metadata).toMatchObject({ reason: 'malformed' })
  })

  it('updates password_hash, sets password_changed_at, and 303s to /settings/password?updated=1 with a session cookie', async () => {
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/password?updated=1')
    expect(response.headers.get('set-cookie')).toBeTruthy()

    const [user] = await db
      .select({ passwordHash: users.passwordHash, passwordChangedAt: users.passwordChangedAt })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(await verifyPassword(user!.passwordHash, NEW_PASSWORD)).toBe(true)
    expect(await verifyPassword(user!.passwordHash, OLD_PASSWORD)).toBe(false)
    expect(user!.passwordChangedAt).not.toBeNull()
  })

  it('issues a cookie that is HttpOnly, Secure, SameSite=Lax, Path=/, and has no Domain', async () => {
    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain=')
  })

  it('deletes unused password_reset_tokens for that user and leaves used rows', async () => {
    await seedToken(activeUserId)
    const used = await seedToken(activeUserId)
    await db
      .update(passwordResetTokens)
      .set({ usedAt: sql`now()` })
      .where(eq(passwordResetTokens.id, used.tokenId))

    await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    const unusedRows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, activeUserId), isNull(passwordResetTokens.usedAt)))
    expect(unusedRows).toHaveLength(0)

    const usedRows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, used.tokenId))
    expect(usedRows).toHaveLength(1)
  })

  it('does not delete another user unused reset tokens', async () => {
    await seedToken(secondUserId)

    await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    const rows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, secondUserId), isNull(passwordResetTokens.usedAt)))
    expect(rows).toHaveLength(1)
  })

  it('audits auth.password_changed with actorUserId and no password in metadata', async () => {
    await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    const audit = await latestAuditFor(activeUserId, 'auth.password_changed')
    expect(audit).toBeTruthy()
    expect(audit!.action).toBe('auth.password_changed')
    expect(JSON.stringify(audit!.metadata)).not.toContain(OLD_PASSWORD)
    expect(JSON.stringify(audit!.metadata)).not.toContain(NEW_PASSWORD)
  })

  it('rejects an old session after passwordChangedAt via isSessionInvalidatedByPasswordChange', async () => {
    const oldCookie = await createSessionCookie(activeUserId)
    const oldToken = oldCookie.match(/enclave_session=([^;]+)/)?.[1]
    if (oldToken === undefined) throw new Error('session cookie did not contain a token')
    const oldPayload = decodeJwt(oldToken)
    const oldIat = oldPayload.iat
    expect(oldIat).toBeDefined()

    // Sleep across a second boundary so the password change strictly follows the old JWT iat.
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    const response = await changePasswordRoute(
      jsonPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(303)

    const [user] = await db
      .select({ passwordChangedAt: users.passwordChangedAt })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(user!.passwordChangedAt).not.toBeNull()
    expect(isSessionInvalidatedByPasswordChange(user!.passwordChangedAt, oldIat)).toBe(true)

    const newCookie = response.headers.get('set-cookie') ?? ''
    const newToken = newCookie.match(/enclave_session=([^;]+)/)?.[1]
    if (newToken === undefined) throw new Error('new session cookie did not contain a token')
    const newPayload = decodeJwt(newToken)
    const newIat = newPayload.iat
    expect(newIat).toBeDefined()
    expect(isSessionInvalidatedByPasswordChange(user!.passwordChangedAt, newIat)).toBe(false)
  })

  it('redirects a form POST with the wrong current password to error=wrong_current', async () => {
    const response = await changePasswordRoute(
      formPost({
        currentPassword: 'wrong-horse-battery',
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/password?error=wrong_current')

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(await verifyPassword(user!.passwordHash, OLD_PASSWORD)).toBe(true)
  })

  it('redirects a successful form POST to updated=1 with a session cookie', async () => {
    const response = await changePasswordRoute(
      formPost({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/settings/password?updated=1')
    expect(response.headers.get('set-cookie')).toBeTruthy()
  })

  it('rate-limits a 31st JSON attempt for the same user', async () => {
    for (let i = 0; i < 30; i++) {
      const response = await changePasswordRoute(
        jsonPost(
          {
            currentPassword: 'wrong-horse-battery',
            newPassword: NEW_PASSWORD,
            confirmNewPassword: NEW_PASSWORD,
          },
          `198.51.100.${i + 1}`,
        ),
      )
      expect(response.status).not.toBe(429)
    }

    const response = await changePasswordRoute(
      jsonPost(
        {
          currentPassword: 'wrong-horse-battery',
          newPassword: NEW_PASSWORD,
          confirmNewPassword: NEW_PASSWORD,
        },
        '198.51.100.255',
      ),
    )

    expect(response.status).toBe(429)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('RATE_LIMITED')
  })
})
