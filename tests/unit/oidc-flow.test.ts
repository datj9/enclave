import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OidcTransaction } from '@/lib/auth/oidc'
import { codeChallengeFrom, startStubIssuer, type StubIssuer } from '../stub-issuer'

/**
 * The authorization-code + PKCE wire flow against an in-process OpenID Provider. No database is
 * involved: these specs stop at the identity the ID token asserts.
 */

const { testEnv } = vi.hoisted(() => ({
  testEnv: {
    NODE_ENV: 'test',
    APP_URL: 'https://enclave.test',
    SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long',
    ALLOW_OPEN_REGISTRATION: false,
    OIDC_ISSUER: undefined as string | undefined,
    OIDC_CLIENT_ID: 'enclave-test-client',
    OIDC_CLIENT_SECRET: 'enclave-test-secret',
  },
}))

vi.mock('@/env', () => ({ env: testEnv }))
vi.mock('@/db', () => ({ db: {} }))

const {
  OIDC_TRANSACTION_COOKIE_NAME,
  exchangeAuthorizationCode,
  openTransaction,
  resetOidcDiscoveryCache,
  startAuthorization,
} = await import('@/lib/auth/oidc')

const DAVE_SUBJECT = '10769150350006150715113'
const DAVE_EMAIL = 'dave@example.com'

let issuer: StubIssuer

beforeAll(async () => {
  issuer = await startStubIssuer(testEnv.OIDC_CLIENT_ID, testEnv.OIDC_CLIENT_SECRET)
  testEnv.OIDC_ISSUER = issuer.issuer
  resetOidcDiscoveryCache()
})

afterAll(async () => {
  await issuer.close()
})

interface StartedFlow {
  readonly authorizationUrl: string
  readonly transaction: OidcTransaction
}

async function startFlow(): Promise<StartedFlow> {
  const { location, setCookie } = await startAuthorization()
  const cookieValue = setCookie.slice(
    `${OIDC_TRANSACTION_COOKIE_NAME}=`.length,
    setCookie.indexOf(';'),
  )

  const transaction = await openTransaction(cookieValue)
  if (transaction === null) throw new Error('the transaction cookie did not verify')
  return { authorizationUrl: location, transaction }
}

function callbackUrl(code: string, state: string): URL {
  const url = new URL('https://enclave.test/api/auth/oidc/callback')
  url.searchParams.set('code', code)
  url.searchParams.set('state', state)
  return url
}

describe('startAuthorization', () => {
  it('sends the browser to the issuer with PKCE, state and nonce', async () => {
    const { authorizationUrl } = await startFlow()
    const parameters = new URL(authorizationUrl).searchParams

    expect(authorizationUrl.startsWith(`${issuer.issuer}/authorize`)).toBe(true)
    expect(parameters.get('response_type')).toBe('code')
    expect(parameters.get('scope')).toBe('openid email profile')
    expect(parameters.get('code_challenge_method')).toBe('S256')
    expect(parameters.get('code_challenge')).not.toBeNull()
    expect(parameters.get('redirect_uri')).toBe('https://enclave.test/api/auth/oidc/callback')
    expect(parameters.get('client_id')).toBe(issuer.clientId)
    expect(parameters.get('state')).not.toBeNull()
    expect(parameters.get('nonce')).not.toBeNull()
  })

  it('never puts the PKCE verifier on the wire', async () => {
    const { authorizationUrl, transaction } = await startFlow()

    expect(authorizationUrl).not.toContain(transaction.codeVerifier)
  })

  it('issues a fresh state and nonce for every attempt', async () => {
    const first = await startFlow()
    const second = await startFlow()

    expect(first.transaction.state).not.toBe(second.transaction.state)
    expect(first.transaction.nonce).not.toBe(second.transaction.nonce)
  })

  it('scopes the transaction cookie to the OIDC routes and keeps it off JavaScript', async () => {
    const { setCookie } = await startAuthorization()

    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/api/auth/oidc')
    expect(setCookie).toContain('Max-Age=600')
  })
})

describe('exchangeAuthorizationCode', () => {
  it('returns the subject and email the ID token asserts', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction),
    ).resolves.toEqual({ subject: DAVE_SUBJECT, email: DAVE_EMAIL })
  })

  it('lowercases the asserted email so it matches the citext column', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: '  Dave@Example.COM ',
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    const identity = await exchangeAuthorizationCode(
      callbackUrl(code, transaction.state),
      transaction,
    )

    expect(identity.email).toBe(DAVE_EMAIL)
  })

  it('rejects an ID token whose nonce is not the one we sent', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: 'n_an_attackers_nonce',
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction),
    ).rejects.toThrow()
  })

  it('rejects an ID token carrying no nonce claim', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction),
    ).rejects.toThrow()
  })

  it('rejects an expired ID token', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
      expiresInSeconds: -60,
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction),
    ).rejects.toThrow()
  })

  it('rejects a state the issuer did not echo back', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, 's_somebody_elses_state'), transaction),
    ).rejects.toThrow()
  })

  it('rejects a code that was not issued for our PKCE verifier', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const stolen = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), {
        ...transaction,
        codeVerifier: stolen.transaction.codeVerifier,
      }),
    ).rejects.toThrow()
  })

  it('refuses an identity the provider explicitly marks unverified', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
      emailVerified: false,
    })

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction),
    ).rejects.toThrow('Sign-in could not be verified')
  })

  it('cannot replay a code that has already been exchanged', async () => {
    const { authorizationUrl, transaction } = await startFlow()
    const code = issuer.issueCode({
      subject: DAVE_SUBJECT,
      email: DAVE_EMAIL,
      nonce: transaction.nonce,
      codeChallenge: codeChallengeFrom(authorizationUrl),
    })

    await exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction)

    await expect(
      exchangeAuthorizationCode(callbackUrl(code, transaction.state), transaction),
    ).rejects.toThrow()
  })
})
