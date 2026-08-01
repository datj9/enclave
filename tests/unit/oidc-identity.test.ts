import { SignJWT } from 'jose'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Everything in S11 that decides *who* is signing in, with no provider and no database in the
 * way. The wire flow against a real issuer lives in oidc-flow.test.ts.
 */

const SESSION_SECRET = 'test-session-secret-at-least-32-bytes-long'

const { testEnv } = vi.hoisted(() => ({
  testEnv: {
    NODE_ENV: 'test',
    APP_URL: 'https://enclave.test',
    SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long',
    ALLOW_OPEN_REGISTRATION: false,
    OIDC_ISSUER: undefined as string | undefined,
    OIDC_CLIENT_ID: undefined as string | undefined,
    OIDC_CLIENT_SECRET: undefined as string | undefined,
  },
}))

interface FakeUserRow {
  readonly id: string
  readonly isActive: boolean
}

const { fakeDatabase } = vi.hoisted(() => ({
  fakeDatabase: {
    /** One batch per `select(...).limit(1)`, in the order the code under test issues them. */
    selectBatches: [] as FakeUserRow[][],
    insertedRows: [] as Record<string, unknown>[],
    insertReturns: [] as { id: string }[],
  },
}))

vi.mock('@/env', () => ({ env: testEnv }))

vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(fakeDatabase.selectBatches.shift() ?? []),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        fakeDatabase.insertedRows.push(row)
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(fakeDatabase.insertReturns),
          }),
        }
      },
    }),
  },
}))

const {
  OIDC_TRANSACTION_COOKIE_NAME,
  OIDC_TRANSACTION_TTL_SECONDS,
  callbackUrlFromRequest,
  clearTransactionCookie,
  isOidcEnabled,
  oidcRedirectUri,
  oidcSettings,
  openTransaction,
  readTransactionCookie,
  rejectionError,
  resolveOidcIdentity,
  stateMatches,
} = await import('@/lib/auth/oidc')

const { GET: startRoute } = await import('@app/api/auth/oidc/start/route')
const { GET: callbackRoute } = await import('@app/api/auth/oidc/callback/route')

function enableProvider(): void {
  testEnv.OIDC_ISSUER = 'https://issuer.example'
  testEnv.OIDC_CLIENT_ID = 'enclave'
  testEnv.OIDC_CLIENT_SECRET = 'a-client-secret'
}

function disableProvider(): void {
  testEnv.OIDC_ISSUER = undefined
  testEnv.OIDC_CLIENT_ID = undefined
  testEnv.OIDC_CLIENT_SECRET = undefined
}

function queueSelects(...batches: FakeUserRow[][]): void {
  fakeDatabase.selectBatches = batches
}

const DAVE = { subject: '10769150350006150715113', email: 'dave@example.com' } as const

beforeEach(() => {
  disableProvider()
  testEnv.ALLOW_OPEN_REGISTRATION = false
  fakeDatabase.selectBatches = []
  fakeDatabase.insertedRows = []
  fakeDatabase.insertReturns = []
})

describe('provider configuration', () => {
  it('is disabled when no OIDC variables are set', () => {
    expect(isOidcEnabled()).toBe(false)
    expect(oidcSettings()).toBeNull()
  })

  it('stays disabled when the issuer is set but the client credentials are not', () => {
    testEnv.OIDC_ISSUER = 'https://issuer.example'

    expect(isOidcEnabled()).toBe(false)
  })

  it('is enabled only once all three variables are present', () => {
    enableProvider()

    expect(isOidcEnabled()).toBe(true)
    expect(oidcSettings()).toEqual({
      issuer: 'https://issuer.example',
      clientId: 'enclave',
      clientSecret: 'a-client-secret',
    })
  })

  it('derives the redirect URI from APP_URL', () => {
    expect(oidcRedirectUri()).toBe('https://enclave.test/api/auth/oidc/callback')
  })
})

describe('routes with no provider configured', () => {
  it('404s the start route', async () => {
    const response = await startRoute(new Request('https://enclave.test/api/auth/oidc/start'))

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('404s the callback route', async () => {
    const response = await callbackRoute(
      new Request('https://enclave.test/api/auth/oidc/callback?code=4%2F0A&state=s_4f'),
    )

    expect(response.status).toBe(404)
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe('transaction cookie', () => {
  async function signTransaction(
    claims: Record<string, unknown>,
    options: { readonly expiresIn?: string; readonly secret?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('enclave')
      .setAudience('enclave-oidc')
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '10m')
      .sign(new TextEncoder().encode(options.secret ?? SESSION_SECRET))
  }

  const VALID_CLAIMS = { state: 's_4f', nonce: 'n_9c', codeVerifier: 'v_1a' }

  it('reads back a transaction it signed', async () => {
    await expect(openTransaction(await signTransaction(VALID_CLAIMS))).resolves.toEqual(
      VALID_CLAIMS,
    )
  })

  it('rejects a missing cookie', async () => {
    await expect(openTransaction(undefined)).resolves.toBeNull()
  })

  it('rejects a cookie that is not a token at all', async () => {
    await expect(openTransaction('not-a-jwt')).resolves.toBeNull()
  })

  it('rejects a transaction signed with a different secret', async () => {
    const forged = await signTransaction(VALID_CLAIMS, {
      secret: 'an-entirely-different-secret-of-32-bytes',
    })

    await expect(openTransaction(forged)).resolves.toBeNull()
  })

  it('rejects a transaction past its ten-minute window', async () => {
    await expect(
      openTransaction(await signTransaction(VALID_CLAIMS, { expiresIn: '-1s' })),
    ).resolves.toBeNull()
  })

  it('rejects a transaction missing the code verifier', async () => {
    const incomplete = await signTransaction({ state: 's_4f', nonce: 'n_9c' })

    await expect(openTransaction(incomplete)).resolves.toBeNull()
  })

  it('expires the cookie on the OIDC path only', () => {
    const cleared = clearTransactionCookie()

    expect(cleared).toContain(`${OIDC_TRANSACTION_COOKIE_NAME}=;`)
    expect(cleared).toContain('Max-Age=0')
    expect(cleared).toContain('HttpOnly')
    expect(cleared).toContain('Secure')
    expect(cleared).toContain('Path=/api/auth/oidc')
  })

  it('keeps the window at ten minutes', () => {
    expect(OIDC_TRANSACTION_TTL_SECONDS).toBe(600)
  })

  it('picks its own cookie out of a header carrying several', () => {
    const request = new Request('https://enclave.test/api/auth/oidc/callback', {
      headers: { cookie: `theme=dark; ${OIDC_TRANSACTION_COOKIE_NAME}=abc.def.ghi; other=1` },
    })

    expect(readTransactionCookie(request)).toBe('abc.def.ghi')
  })

  it('returns undefined when the header carries no OIDC cookie', () => {
    const request = new Request('https://enclave.test/api/auth/oidc/callback', {
      headers: { cookie: 'theme=dark' },
    })

    expect(readTransactionCookie(request)).toBeUndefined()
  })

  it('returns undefined when there is no cookie header', () => {
    expect(readTransactionCookie(new Request('https://enclave.test/'))).toBeUndefined()
  })
})

describe('stateMatches', () => {
  it('accepts the state it issued', () => {
    expect(stateMatches('s_4f7a', 's_4f7a')).toBe(true)
  })

  it('rejects a different state of the same length', () => {
    expect(stateMatches('s_4f7a', 's_4f7b')).toBe(false)
  })

  it('rejects a state of a different length', () => {
    expect(stateMatches('s_4f7a7a', 's_4f7a')).toBe(false)
  })

  it('rejects a callback that carried no state at all', () => {
    expect(stateMatches(null, 's_4f7a')).toBe(false)
  })
})

describe('callbackUrlFromRequest', () => {
  it('rebuilds the registered redirect URI and keeps the query', () => {
    const request = new Request(
      'http://internal-pod:3000/api/auth/oidc/callback?code=4%2F0A&state=s_4f',
    )

    expect(callbackUrlFromRequest(request).toString()).toBe(
      'https://enclave.test/api/auth/oidc/callback?code=4%2F0A&state=s_4f',
    )
  })
})

describe('resolveOidcIdentity', () => {
  it('matches a returning user on oidc_sub', async () => {
    queueSelects([{ id: 'user-1', isActive: true }])

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: true,
      userId: 'user-1',
      created: false,
    })
    expect(fakeDatabase.insertedRows).toHaveLength(0)
  })

  it('refuses a deactivated user', async () => {
    queueSelects([{ id: 'user-1', isActive: false }])

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: false,
      reason: 'deactivated',
    })
  })

  it('never links to a password account that happens to share the email', async () => {
    queueSelects([], [{ id: 'password-user', isActive: true }])

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: false,
      reason: 'email_taken',
    })
    expect(fakeDatabase.insertedRows).toHaveLength(0)
  })

  it('rejects an unknown identity while registration is closed', async () => {
    queueSelects([], [])

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: false,
      reason: 'registration_closed',
    })
    expect(fakeDatabase.insertedRows).toHaveLength(0)
  })

  it('creates a password-less member when open registration is on', async () => {
    testEnv.ALLOW_OPEN_REGISTRATION = true
    queueSelects([], [])
    fakeDatabase.insertReturns = [{ id: 'user-new' }]

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: true,
      userId: 'user-new',
      created: true,
    })
    expect(fakeDatabase.insertedRows[0]).toEqual({
      email: DAVE.email,
      passwordHash: null,
      oidcSub: DAVE.subject,
      role: 'member',
      isActive: true,
    })
  })

  it('falls back to the winner of a concurrent first sign-in', async () => {
    testEnv.ALLOW_OPEN_REGISTRATION = true
    queueSelects([], [], [{ id: 'user-race-winner', isActive: true }])
    fakeDatabase.insertReturns = []

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: true,
      userId: 'user-race-winner',
      created: false,
    })
  })

  it('reports the email as taken when the insert conflicted on nothing else', async () => {
    testEnv.ALLOW_OPEN_REGISTRATION = true
    queueSelects([], [], [])
    fakeDatabase.insertReturns = []

    await expect(resolveOidcIdentity(DAVE)).resolves.toEqual({
      ok: false,
      reason: 'email_taken',
    })
  })
})

describe('rejectionError', () => {
  it('tells an invite-only instance apart from a taken email', () => {
    expect(rejectionError('registration_closed').message).toBe('This instance is invite-only')
    expect(rejectionError('email_taken').message).toContain('Sign in with your password')
  })

  it('says nothing about why a deactivated account was refused', () => {
    expect(rejectionError('deactivated').message).toBe('This account cannot sign in')
  })

  it('answers 403 for every rejection', () => {
    expect(rejectionError('deactivated').status).toBe(403)
    expect(rejectionError('email_taken').status).toBe(403)
    expect(rejectionError('registration_closed').status).toBe(403)
  })
})
