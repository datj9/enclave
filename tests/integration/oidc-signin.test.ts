import { inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { codeChallengeFrom, startStubIssuer } from '../stub-issuer'

/**
 * The S11 routes end to end against real Postgres and an in-process OpenID Provider, with
 * `ALLOW_OPEN_REGISTRATION=false` — the shipped default. Registration is covered separately in
 * oidc-registration.test.ts, because the flag is read once per process.
 *
 * The environment has to be pointed at the stub before anything reads `env`, so every module
 * under test is imported dynamically below.
 */

const issuer = await startStubIssuer('enclave-integration', 'enclave-integration-secret')

process.env.OIDC_ISSUER = issuer.issuer
process.env.OIDC_CLIENT_ID = issuer.clientId
process.env.OIDC_CLIENT_SECRET = issuer.clientSecret
process.env.ALLOW_OPEN_REGISTRATION = 'false'

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

const OIDC_ONLY_EMAIL = 'oidc-returning@example.test'
const OIDC_ONLY_SUBJECT = 'stub|returning-user'
const DEACTIVATED_EMAIL = 'oidc-deactivated@example.test'
const DEACTIVATED_SUBJECT = 'stub|deactivated-user'
const PASSWORD_USER_EMAIL = 'oidc-collision@example.test'
const UNKNOWN_SUBJECT = 'stub|never-seen-before'
const STRANGER_EMAIL = 'oidc-stranger@example.test'

const TEST_EMAILS = [OIDC_ONLY_EMAIL, DEACTIVATED_EMAIL, PASSWORD_USER_EMAIL, STRANGER_EMAIL]

interface StartedFlow {
  readonly state: string
  readonly nonce: string
  readonly codeChallenge: string
  readonly transactionCookie: string
}

async function startFlow(): Promise<StartedFlow> {
  const response = await startRoute(new Request('https://enclave.test/api/auth/oidc/start'))
  expect(response.status).toBe(302)

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

function callback(flow: StartedFlow, query: Readonly<Record<string, string>>): Promise<Response> {
  const url = new URL('https://enclave.test/api/auth/oidc/callback')
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)

  return callbackRoute(
    new Request(url, { headers: { cookie: flow.transactionCookie } }),
  ) as Promise<Response>
}

function sessionCookieOf(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))
}

async function errorCodeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

async function removeTestUsers(): Promise<void> {
  await db.delete(users).where(inArray(users.email, TEST_EMAILS))
}

describe.skipIf(!databaseReady)('OIDC sign-in with registration closed', () => {
  beforeAll(async () => {
    await removeTestUsers()
    await db.insert(users).values([
      {
        email: OIDC_ONLY_EMAIL,
        passwordHash: null,
        oidcSub: OIDC_ONLY_SUBJECT,
        role: 'member',
        isActive: true,
      },
      {
        email: DEACTIVATED_EMAIL,
        passwordHash: null,
        oidcSub: DEACTIVATED_SUBJECT,
        role: 'member',
        isActive: false,
      },
      {
        email: PASSWORD_USER_EMAIL,
        passwordHash: '$argon2id$stub',
        oidcSub: null,
        role: 'member',
        isActive: true,
      },
    ])
  })

  afterAll(async () => {
    await removeTestUsers()
    await issuer.close()
  })

  beforeEach(() => {
    resetRateLimits()
  })

  it('signs in a returning user matched on oidc_sub, not on the asserted email', async () => {
    const flow = await startFlow()
    // The ID token asserts an address that belongs to a different, password-only account.
    const code = issuer.issueCode({
      subject: OIDC_ONLY_SUBJECT,
      email: PASSWORD_USER_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: flow.state })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')
    expect(sessionCookieOf(response)).toContain('HttpOnly')

    const matched = await db
      .select({ email: users.email })
      .from(users)
      .where(inArray(users.oidcSub, [OIDC_ONLY_SUBJECT]))
    expect(matched).toEqual([{ email: OIDC_ONLY_EMAIL }])
  })

  it('clears the transaction cookie once the code has been spent', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: OIDC_ONLY_SUBJECT,
      email: OIDC_ONLY_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: flow.state })

    expect(response.headers.getSetCookie()).toContainEqual(
      expect.stringContaining('enclave_oidc=; HttpOnly'),
    )
  })

  it('refuses a deactivated user', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: DEACTIVATED_SUBJECT,
      email: DEACTIVATED_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: flow.state })

    expect(response.status).toBe(403)
    expect(await errorCodeOf(response)).toBe('FORBIDDEN')
    expect(sessionCookieOf(response)).toBeUndefined()
  })

  it('never links an unknown identity to a password account sharing its email', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: UNKNOWN_SUBJECT,
      email: PASSWORD_USER_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: flow.state })

    expect(response.status).toBe(403)
    expect(sessionCookieOf(response)).toBeUndefined()

    const [existing] = await db
      .select({ oidcSub: users.oidcSub })
      .from(users)
      .where(inArray(users.email, [PASSWORD_USER_EMAIL]))
    expect(existing?.oidcSub).toBeNull()
  })

  it('rejects an unknown identity on an invite-only instance without creating a user', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: UNKNOWN_SUBJECT,
      email: STRANGER_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: flow.state })

    expect(response.status).toBe(403)
    expect(await response.clone().json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'This instance is invite-only' },
    })
    expect(sessionCookieOf(response)).toBeUndefined()

    const created = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.email, [STRANGER_EMAIL]))
    expect(created).toEqual([])
  })

  it('answers 400 and sets no session when the state does not match', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: OIDC_ONLY_SUBJECT,
      email: OIDC_ONLY_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: 's_forged_by_a_third_party' })

    expect(response.status).toBe(400)
    expect(await errorCodeOf(response)).toBe('VALIDATION_FAILED')
    expect(sessionCookieOf(response)).toBeUndefined()
  })

  it('answers 400 and sets no session when the nonce does not match', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: OIDC_ONLY_SUBJECT,
      email: OIDC_ONLY_EMAIL,
      nonce: 'n_from_another_transaction',
      codeChallenge: flow.codeChallenge,
    })

    const response = await callback(flow, { code, state: flow.state })

    expect(response.status).toBe(400)
    expect(sessionCookieOf(response)).toBeUndefined()
  })

  it('answers 400 when the callback arrives with no transaction cookie', async () => {
    const flow = await startFlow()
    const code = issuer.issueCode({
      subject: OIDC_ONLY_SUBJECT,
      email: OIDC_ONLY_EMAIL,
      nonce: flow.nonce,
      codeChallenge: flow.codeChallenge,
    })

    const url = new URL('https://enclave.test/api/auth/oidc/callback')
    url.searchParams.set('code', code)
    url.searchParams.set('state', flow.state)
    const response = await callbackRoute(new Request(url))

    expect(response.status).toBe(400)
    expect(sessionCookieOf(response)).toBeUndefined()
  })

  it('sends a visitor who cancelled at the provider back to the sign-in form', async () => {
    const flow = await startFlow()

    const response = await callback(flow, { error: 'access_denied', state: flow.state })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/signin?error=oidc')
    expect(sessionCookieOf(response)).toBeUndefined()
  })
})
