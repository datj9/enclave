import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { codeChallengeFrom, startStubIssuer } from '../stub-issuer'

/**
 * First OIDC sign-in on an instance that accepts open registration. Separate from
 * oidc-signin.test.ts because `ALLOW_OPEN_REGISTRATION` is read once per process.
 */

const issuer = await startStubIssuer('enclave-registration', 'enclave-registration-secret')

process.env.OIDC_ISSUER = issuer.issuer
process.env.OIDC_CLIENT_ID = issuer.clientId
process.env.OIDC_CLIENT_SECRET = issuer.clientSecret
process.env.ALLOW_OPEN_REGISTRATION = 'true'

const { db, pingDatabase } = await import('@/db')
const { users } = await import('@/db/schema')
const { SESSION_COOKIE_NAME } = await import('@/lib/auth/session')
const { resetRateLimits } = await import('@/lib/rate-limit')
const { GET: startRoute } = await import('@app/api/auth/oidc/start/route')
const { GET: callbackRoute } = await import('@app/api/auth/oidc/callback/route')

const databaseReady = await pingDatabase().then(
  () => true,
  () => false,
)

const NEWCOMER_EMAIL = 'oidc-newcomer@example.test'
const NEWCOMER_SUBJECT = 'stub|first-time-visitor'

interface StartedFlow {
  readonly state: string
  readonly nonce: string
  readonly codeChallenge: string
  readonly transactionCookie: string
}

async function startFlow(): Promise<StartedFlow> {
  const response = await startRoute(new Request('https://enclave.test/api/auth/oidc/start'))
  const location = response.headers.get('location')
  const setCookie = response.headers.get('set-cookie')
  if (location === null || setCookie === null) throw new Error('the start route set no redirect')

  const parameters = new URL(location).searchParams
  return {
    state: parameters.get('state') ?? '',
    nonce: parameters.get('nonce') ?? '',
    codeChallenge: codeChallengeFrom(location),
    transactionCookie: setCookie.slice(0, setCookie.indexOf(';')),
  }
}

async function signInAsNewcomer(): Promise<Response> {
  const flow = await startFlow()
  const code = issuer.issueCode({
    subject: NEWCOMER_SUBJECT,
    email: NEWCOMER_EMAIL,
    nonce: flow.nonce,
    codeChallenge: flow.codeChallenge,
  })

  const url = new URL('https://enclave.test/api/auth/oidc/callback')
  url.searchParams.set('code', code)
  url.searchParams.set('state', flow.state)
  return callbackRoute(new Request(url, { headers: { cookie: flow.transactionCookie } }))
}

async function removeTestUsers(): Promise<void> {
  await db.delete(users).where(inArray(users.email, [NEWCOMER_EMAIL]))
}

describe.skipIf(!databaseReady)('first OIDC sign-in with open registration', () => {
  beforeAll(removeTestUsers)

  afterAll(async () => {
    await removeTestUsers()
    await issuer.close()
  })

  beforeEach(() => {
    resetRateLimits()
  })

  it('creates a password-less member and starts a session', async () => {
    const response = await signInAsNewcomer()

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)),
    ).toBe(true)

    const created = await db
      .select({
        email: users.email,
        passwordHash: users.passwordHash,
        oidcSub: users.oidcSub,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(inArray(users.email, [NEWCOMER_EMAIL]))

    expect(created).toEqual([
      {
        email: NEWCOMER_EMAIL,
        passwordHash: null,
        oidcSub: NEWCOMER_SUBJECT,
        role: 'member',
        isActive: true,
      },
    ])
  })

  it('reuses that row on the next sign-in instead of creating a second one', async () => {
    const response = await signInAsNewcomer()

    expect(response.status).toBe(303)

    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.email, [NEWCOMER_EMAIL]))
    expect(rows).toHaveLength(1)
  })
})
