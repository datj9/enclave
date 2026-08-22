import { eq, inArray, isNull, and, desc, sql } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db, pingDatabase } from '@/db'
import { auditLog, type AuditAction } from '@/db/schema/audit-log'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { users } from '@/db/schema/users'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import {
  hashPasswordResetToken,
  isPasswordResetTokenShaped,
  mintPasswordResetToken,
} from '@/lib/auth/password-reset-tokens'
import { isSessionInvalidatedByPasswordChange } from '@/lib/auth/session-freshness'
import { createSessionCookie } from '@/lib/auth/session'
import { setMailTransporterForTests } from '@/lib/mail/smtp'
import { resetRateLimits } from '@/lib/rate-limit'

const ACTIVE_EMAIL = 'pwreset-active@example.test'
const DEACTIVATED_EMAIL = 'pwreset-deactivated@example.test'
const OIDC_EMAIL = 'pwreset-oidc@example.test'
const SECOND_EMAIL = 'pwreset-second@example.test'
const UNKNOWN_EMAIL = 'pwreset-unknown@example.test'

const TEST_EMAILS = [ACTIVE_EMAIL, DEACTIVATED_EMAIL, OIDC_EMAIL, SECOND_EMAIL]

const OLD_PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'new-correct-horse'

// The env module is cached on the first read, which happens below via pingDatabase().
// Ensure SMTP_HOST is present so the mail-enabled integration paths run.
process.env.SMTP_HOST = 'smtp.test.invalid'

const databaseReady = await pingDatabase().then(
  () => true,
  () => false,
)

if (!databaseReady) {
  console.warn('[enclave] skipping tests/integration/password-reset: no database on DATABASE_URL.')
}

const { POST: forgotPasswordRoute } = await import('@app/api/auth/forgot-password/route')
const { POST: resetPasswordRoute } = await import('@app/api/auth/reset-password/route')

let activeUserId = ''
let deactivatedUserId = ''
let oidcUserId = ''
let secondUserId = ''

interface SentMessage {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly text: string
}

let sent: SentMessage[] = []

function jsonPost(path: string, body: unknown, forwardedFor = '198.51.100.10'): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    body: JSON.stringify(body),
  })
}

function extractTokenFromMail(message: SentMessage): string {
  const match = message.text.match(/https?:\/\/\S+/)
  if (match === null) throw new Error('no reset url found in mail')
  const url = new URL(match[0])
  const token = url.searchParams.get('t')
  if (token === null) throw new Error('no token in reset url')
  return token
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

async function removeTestTokens(): Promise<void> {
  const ids = [activeUserId, deactivatedUserId, oidcUserId, secondUserId].filter((id) => id !== '')
  if (ids.length > 0) {
    await db.delete(passwordResetTokens).where(inArray(passwordResetTokens.userId, ids))
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

async function ageTokenOnDatabaseClock(tokenId: string): Promise<void> {
  await db
    .update(passwordResetTokens)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(passwordResetTokens.id, tokenId))
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

describe.skipIf(!databaseReady)('POST /api/auth/forgot-password', () => {
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
        {
          email: DEACTIVATED_EMAIL,
          passwordHash: await hashPassword(OLD_PASSWORD),
          role: 'member',
          isActive: false,
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
      else if (user.email === DEACTIVATED_EMAIL) deactivatedUserId = user.id
      else if (user.email === OIDC_EMAIL) oidcUserId = user.id
      else if (user.email === SECOND_EMAIL) secondUserId = user.id
    }
  })

  afterAll(removeTestRows)

  beforeEach(async () => {
    sent = []
    resetRateLimits()
    vi.stubEnv('SMTP_HOST', 'smtp.test.invalid')
    await removeTestTokens()
    setMailTransporterForTests({
      sendMail: vi.fn(async (message) => {
        sent.push(message as SentMessage)
      }),
    })
  })

  it('returns the generic success redirect for an unknown email and writes no token row', async () => {
    const response = await forgotPasswordRoute(
      jsonPost('/api/auth/forgot-password', { email: UNKNOWN_EMAIL }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/forgot-password?sent=1')

    const rows = await db.select({ id: passwordResetTokens.id }).from(passwordResetTokens)
    expect(rows).toHaveLength(0)
  })

  it('returns the same generic success for a deactivated user and writes no token row', async () => {
    const response = await forgotPasswordRoute(
      jsonPost('/api/auth/forgot-password', { email: DEACTIVATED_EMAIL }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/forgot-password?sent=1')

    const rows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, deactivatedUserId))
    expect(rows).toHaveLength(0)
  })

  it('returns the same generic success for an OIDC-only user and writes no token row', async () => {
    const response = await forgotPasswordRoute(
      jsonPost('/api/auth/forgot-password', { email: OIDC_EMAIL }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/forgot-password?sent=1')

    const rows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, oidcUserId))
    expect(rows).toHaveLength(0)
  })

  it('mints a digest-only row and sends a plaintext mail containing the reset url for an active password user', async () => {
    const response = await forgotPasswordRoute(
      jsonPost('/api/auth/forgot-password', { email: ACTIVE_EMAIL }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/forgot-password?sent=1')

    expect(sent).toHaveLength(1)
    const plaintext = extractTokenFromMail(sent[0]!)
    expect(isPasswordResetTokenShaped(plaintext)).toBe(true)
    expect(sent[0]!.text).toContain('This link expires in 1 hour.')

    const rows = await db
      .select({ tokenHash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, activeUserId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash.equals(hashPasswordResetToken(plaintext))).toBe(true)
    expect(rows[0]!.tokenHash.toString('utf8')).not.toContain(plaintext)
  })

  it('audits auth.password_reset_requested with mailed true and does not store the plaintext token in metadata', async () => {
    await forgotPasswordRoute(jsonPost('/api/auth/forgot-password', { email: ACTIVE_EMAIL }))

    const plaintext = extractTokenFromMail(sent[0]!)

    const audit = await latestAuditFor(activeUserId, 'auth.password_reset_requested')
    expect(audit).toBeTruthy()
    expect(audit!.metadata).toMatchObject({ mailed: true })
    expect(JSON.stringify(audit!.metadata)).not.toContain(plaintext)
  })

  it('audits mailed false when SMTP_HOST is unset and does not insert a token', async () => {
    const previous = process.env.SMTP_HOST
    try {
      delete process.env.SMTP_HOST
      vi.resetModules()

      const { POST } = await import('@app/api/auth/forgot-password/route')
      const { isMailConfigured } = await import('@/lib/mail/smtp')
      expect(isMailConfigured()).toBe(false)

      const response = await POST(jsonPost('/api/auth/forgot-password', { email: ACTIVE_EMAIL }))

      expect(response.status).toBe(303)
      expect(response.headers.get('location')).toBe('/forgot-password?sent=1')

      const rows = await db
        .select({ id: passwordResetTokens.id })
        .from(passwordResetTokens)
        .where(eq(passwordResetTokens.userId, activeUserId))
      expect(rows).toHaveLength(0)

      const audit = await latestAuditFor(activeUserId, 'auth.password_reset_requested')
      expect(audit).toBeTruthy()
      expect(audit!.metadata).toMatchObject({ mailed: false })
    } finally {
      process.env.SMTP_HOST = previous
    }
  })

  it('still returns generic success when sendMail throws, auditing mailed false', async () => {
    setMailTransporterForTests({
      sendMail: vi.fn(async () => {
        throw new Error('SMTP down')
      }),
    })

    const response = await forgotPasswordRoute(
      jsonPost('/api/auth/forgot-password', { email: ACTIVE_EMAIL }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/forgot-password?sent=1')

    const rows = await db
      .select({ usedAt: passwordResetTokens.usedAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, activeUserId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.usedAt).toBeNull()

    const audit = await latestAuditFor(activeUserId, 'auth.password_reset_requested')
    expect(audit).toBeTruthy()
    expect(audit!.metadata).toMatchObject({ mailed: false })
  })

  it('deletes unused tokens for that user before inserting a new one', async () => {
    const old = await seedToken(activeUserId)

    await forgotPasswordRoute(jsonPost('/api/auth/forgot-password', { email: ACTIVE_EMAIL }))

    const plaintext = extractTokenFromMail(sent[0]!)

    const rows = await db
      .select({ tokenHash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, activeUserId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash.equals(hashPasswordResetToken(plaintext))).toBe(true)

    const oldRows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, hashPasswordResetToken(old.plaintext)))
    expect(oldRows).toHaveLength(0)
  })

  it('does not consume the per-email limiter before a valid email is parsed', async () => {
    const response = await forgotPasswordRoute(
      jsonPost('/api/auth/forgot-password', { email: 'not-an-email' }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('rate-limits a third-party email independently of IP after a valid parse', async () => {
    const email = 'pwreset-rate-limit@example.test'

    for (let i = 0; i < 30; i++) {
      const response = await forgotPasswordRoute(jsonPost('/api/auth/forgot-password', { email }))
      expect(response.status).toBe(303)
    }

    const response = await forgotPasswordRoute(jsonPost('/api/auth/forgot-password', { email }))
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error?: { code: string } }
    expect(body.error?.code).toBe('RATE_LIMITED')
  })
})

describe.skipIf(!databaseReady)('POST /api/auth/reset-password', () => {
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
      else if (user.email === SECOND_EMAIL) secondUserId = user.id
    }
  })

  afterAll(removeTestRows)

  beforeEach(async () => {
    sent = []
    resetRateLimits()
    vi.stubEnv('SMTP_HOST', 'smtp.test.invalid')
    await removeTestTokens()
    setMailTransporterForTests({
      sendMail: vi.fn(async (message) => {
        sent.push(message as SentMessage)
      }),
    })
  })

  it('consumes a valid token, updates password_hash, sets password_changed_at, and 303s to /dashboard with a session cookie', async () => {
    const { plaintext } = await seedToken(activeUserId)

    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')
    expect(response.headers.get('set-cookie')).toBeTruthy()

    const [user] = await db
      .select({ passwordHash: users.passwordHash, passwordChangedAt: users.passwordChangedAt })
      .from(users)
      .where(eq(users.id, activeUserId))
    expect(await verifyPassword(user!.passwordHash, NEW_PASSWORD)).toBe(true)
    expect(await verifyPassword(user!.passwordHash, OLD_PASSWORD)).toBe(false)
    expect(user!.passwordChangedAt).not.toBeNull()
  })

  it('rejects a second consume of the same token with the generic failure', async () => {
    const { plaintext } = await seedToken(activeUserId)

    await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )
    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('This reset link is invalid or has expired.')
  })

  it('rejects an expired token with the generic failure', async () => {
    const { plaintext, tokenId } = await seedToken(activeUserId)
    await ageTokenOnDatabaseClock(tokenId)

    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('This reset link is invalid or has expired.')
  })

  it('rejects a malformed token without a database lookup error and uses the generic message', async () => {
    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', {
        token: 'inv_abcdefghijklmnop',
        password: NEW_PASSWORD,
      }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('This reset link is invalid or has expired.')
  })

  it('rejects a short password with the length message and leaves the token unused', async () => {
    const { plaintext, tokenId } = await seedToken(activeUserId)

    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: 'short' }),
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { error?: { message: string } }
    expect(body.error?.message).toBe('Enter a password of at least 12 characters')

    const [row] = await db
      .select({ usedAt: passwordResetTokens.usedAt })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.id, tokenId))
    expect(row!.usedAt).toBeNull()
  })

  it('invalidates other unused tokens for that user on success', async () => {
    await seedToken(activeUserId)
    const second = await seedToken(activeUserId)

    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: second.plaintext, password: NEW_PASSWORD }),
    )

    expect(response.status).toBe(303)

    const rows = await db
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, activeUserId), isNull(passwordResetTokens.usedAt)))
    expect(rows).toHaveLength(0)
  })

  it('issues a cookie that is HttpOnly, Secure, SameSite=Lax, Path=/, and has no Domain', async () => {
    const { plaintext } = await seedToken(activeUserId)

    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toContain('Domain=')
  })

  it('audits auth.password_reset_completed with actorUserId and no plaintext token', async () => {
    const { plaintext } = await seedToken(activeUserId)

    await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )

    const audit = await latestAuditFor(activeUserId, 'auth.password_reset_completed')
    expect(audit).toBeTruthy()
    expect(audit!.action).toBe('auth.password_reset_completed')
    expect(JSON.stringify(audit!.metadata)).not.toContain(plaintext)
  })

  it('audits auth.password_reset_failed for a used token without saying it was used', async () => {
    const { plaintext } = await seedToken(activeUserId)

    await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )
    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
    )

    expect(response.status).toBe(422)
    const audit = await latestAuditFor(activeUserId, 'auth.password_reset_failed')
    expect(audit).toBeTruthy()
    expect(audit!.metadata).toMatchObject({ reason: 'invalid_token' })
    expect(JSON.stringify(audit!.metadata)).not.toContain('used')
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

    const { plaintext } = await seedToken(activeUserId)
    const response = await resetPasswordRoute(
      jsonPost('/api/auth/reset-password', { token: plaintext, password: NEW_PASSWORD }),
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
})
