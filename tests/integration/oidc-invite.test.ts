import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { codeChallengeFrom, startStubIssuer } from '../stub-issuer'

/**
 * The S10 seam in `src/lib/auth/oidc.ts`: on an invite-only instance a first OIDC sign-in is
 * refused unless an outstanding invite names the address the provider asserted — and redeeming it
 * happens in the same transaction as the `users` insert, so the invite is burnt exactly when an
 * account appears.
 *
 * `ALLOW_OPEN_REGISTRATION` is read per process, so this file keeps the default (false) and is
 * separate from oidc-registration.test.ts, which sets it true.
 */

const issuer = await startStubIssuer('enclave-invite', 'enclave-invite-secret')

process.env.OIDC_ISSUER = issuer.issuer
process.env.OIDC_CLIENT_ID = issuer.clientId
process.env.OIDC_CLIENT_SECRET = issuer.clientSecret
process.env.ALLOW_OPEN_REGISTRATION = 'false'

const { db, pingDatabase } = await import('@/db')
const { invites } = await import('@/db/schema/invites')
const { users } = await import('@/db/schema/users')
const { createInvite } = await import('@/lib/invites/manage')
const { resetRateLimits } = await import('@/lib/rate-limit')
const { GET: startRoute } = await import('@app/api/auth/oidc/start/route')
const { GET: callbackRoute } = await import('@app/api/auth/oidc/callback/route')

const databaseReady = await pingDatabase().then(
  () => true,
  () => false,
)

if (!databaseReady) {
  console.warn('[enclave] skipping tests/integration/oidc-invite: no database')
}

const ADMIN_EMAIL = 'oidc-invite-admin@example.test'
const INVITED_EMAIL = 'oidc-invited@example.test'
const UNINVITED_EMAIL = 'oidc-uninvited@example.test'

const TEST_EMAILS = [ADMIN_EMAIL, INVITED_EMAIL, UNINVITED_EMAIL]

let adminId = ''

async function removeTestRows(): Promise<void> {
  const testUsers = await db.select({ id: users.id }).from(users).where(inArray(users.email, TEST_EMAILS))
  const ids = testUsers.map((user) => user.id)

  if (ids.length > 0) {
    await db.update(invites).set({ usedBy: null }).where(inArray(invites.usedBy, ids))
    await db.delete(invites).where(inArray(invites.createdBy, ids))
  }
  await db.delete(users).where(inArray(users.email, TEST_EMAILS))
}

async function signInAs(email: string, subject: string): Promise<Response> {
  const response = await startRoute(new Request('https://enclave.test/api/auth/oidc/start'))
  const location = response.headers.get('location')
  const setCookie = response.headers.get('set-cookie')
  if (location === null || setCookie === null) throw new Error('the start route set no redirect')

  const parameters = new URL(location).searchParams
  const code = issuer.issueCode({
    subject,
    email,
    nonce: parameters.get('nonce') ?? '',
    codeChallenge: codeChallengeFrom(location),
  })

  const callbackUrl = new URL('https://enclave.test/api/auth/oidc/callback')
  callbackUrl.searchParams.set('code', code)
  callbackUrl.searchParams.set('state', parameters.get('state') ?? '')
  return callbackRoute(
    new Request(callbackUrl, { headers: { cookie: setCookie.slice(0, setCookie.indexOf(';')) } }),
  )
}

describe.skipIf(!databaseReady)('first OIDC sign-in on an invite-only instance', () => {
  beforeAll(async () => {
    await removeTestRows()
    const [admin] = await db
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash: null, role: 'admin', isActive: true })
      .returning({ id: users.id })

    if (admin === undefined) throw new Error('could not create the oidc invite test admin')
    adminId = admin.id
  })

  afterAll(async () => {
    await removeTestRows()
    await issuer.close()
  })

  beforeEach(() => {
    resetRateLimits()
  })

  it('refuses an unknown identity that no invite names', async () => {
    const response = await signInAs(UNINVITED_EMAIL, 'stub|uninvited')

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'This instance is invite-only' },
    })

    const created = await db.select({ id: users.id }).from(users).where(eq(users.email, UNINVITED_EMAIL))
    expect(created).toHaveLength(0)
  })

  it('creates the member and burns the invite when one names the asserted address', async () => {
    const invite = await createInvite({
      createdBy: adminId,
      email: INVITED_EMAIL,
      expiresInHours: 72,
    })

    const response = await signInAs(INVITED_EMAIL, 'stub|invited')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')

    const [member] = await db
      .select({ id: users.id, role: users.role, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, INVITED_EMAIL))
    expect(member?.role).toBe('member')
    expect(member?.passwordHash).toBeNull()

    const [row] = await db
      .select({ usedAt: invites.usedAt, usedBy: invites.usedBy })
      .from(invites)
      .where(eq(invites.id, invite.inviteId))
    expect(row?.usedAt).not.toBeNull()
    expect(row?.usedBy).toBe(member?.id)
  })

  it('does not burn a second invite on the returning member’s next sign-in', async () => {
    const spare = await createInvite({
      createdBy: adminId,
      email: INVITED_EMAIL,
      expiresInHours: 72,
    })

    const response = await signInAs(INVITED_EMAIL, 'stub|invited')
    expect(response.status).toBe(303)

    const [row] = await db
      .select({ usedAt: invites.usedAt })
      .from(invites)
      .where(eq(invites.id, spare.inviteId))
    expect(row?.usedAt).toBeNull()

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, INVITED_EMAIL))
    expect(rows).toHaveLength(1)
  })

  it('will not let a link-only invite authorise an OIDC identity', async () => {
    await createInvite({ createdBy: adminId, email: null, expiresInHours: 72 })

    const response = await signInAs(UNINVITED_EMAIL, 'stub|uninvited-again')

    expect(response.status).toBe(403)
    const created = await db.select({ id: users.id }).from(users).where(eq(users.email, UNINVITED_EMAIL))
    expect(created).toHaveLength(0)
  })
})
