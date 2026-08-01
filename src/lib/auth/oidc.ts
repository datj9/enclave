import { timingSafeEqual } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { SignJWT, jwtVerify } from 'jose'
import * as client from 'openid-client'
import { db } from '@/db'
import { users } from '@/db/schema'
import { env } from '@/env'
import { HttpError } from '@/lib/http'
import {
  claimInvite,
  findRedeemableInviteByEmail,
  isInviteRedeemable,
  lockInvite,
  type DbHandle,
} from '@/lib/invites/redeem'

/**
 * Optional OIDC sign-in (grill-result §8, A.9.4.2). Everything here is inert until all three of
 * OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET are set, which is what makes the provider
 * opt-in per instance.
 *
 * Never log an authorization code, an ID token, the client secret, or a PKCE verifier.
 */

export const OIDC_TRANSACTION_COOKIE_NAME = 'enclave_oidc'
export const OIDC_TRANSACTION_TTL_SECONDS = 600

/** Scoped to the OIDC routes so an ordinary app request never carries the in-flight secrets. */
const TRANSACTION_COOKIE_PATH = '/api/auth/oidc'
const TRANSACTION_ISSUER = 'enclave'
const TRANSACTION_AUDIENCE = 'enclave-oidc'

const OIDC_SCOPE = 'openid email profile'
const CALLBACK_PATH = '/api/auth/oidc/callback'

/** One message for every verification failure: it distinguishes nothing (§8, A.9.4.2). */
export const OIDC_VERIFICATION_FAILURE = 'Sign-in could not be verified, please try again'

export interface OidcSettings {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
}

export function oidcSettings(): OidcSettings | null {
  const issuer = env.OIDC_ISSUER
  const clientId = env.OIDC_CLIENT_ID
  const clientSecret = env.OIDC_CLIENT_SECRET

  if (issuer === undefined || clientId === undefined || clientSecret === undefined) return null
  return { issuer, clientId, clientSecret }
}

export function isOidcEnabled(): boolean {
  return oidcSettings() !== null
}

function requireOidcSettings(): OidcSettings {
  const settings = oidcSettings()
  if (settings === null) throw new HttpError('NOT_FOUND', 'Not found')
  return settings
}

export function oidcRedirectUri(): string {
  return new URL(CALLBACK_PATH, env.APP_URL).toString()
}

const configurationByIssuer = new Map<string, Promise<client.Configuration>>()

/** A plaintext issuer is reachable only from a developer machine and from the stub-issuer test. */
function issuerAllowsPlaintext(issuer: string): boolean {
  return new URL(issuer).protocol === 'http:' && env.NODE_ENV !== 'production'
}

function oidcConfiguration(settings: OidcSettings): Promise<client.Configuration> {
  const cached = configurationByIssuer.get(settings.issuer)
  if (cached !== undefined) return cached

  const discovered = client
    .discovery(
      new URL(settings.issuer),
      settings.clientId,
      settings.clientSecret,
      undefined,
      issuerAllowsPlaintext(settings.issuer)
        ? { execute: [client.allowInsecureRequests] }
        : undefined,
    )
    .catch((error: unknown) => {
      // Otherwise one unreachable-issuer boot would poison the cache for the process lifetime.
      configurationByIssuer.delete(settings.issuer)
      throw error
    })

  configurationByIssuer.set(settings.issuer, discovered)
  return discovered
}

/** Test-only; there is no production caller. */
export function resetOidcDiscoveryCache(): void {
  configurationByIssuer.clear()
}

export interface OidcTransaction {
  readonly state: string
  readonly nonce: string
  readonly codeVerifier: string
}

function transactionKey(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET)
}

/**
 * Signed rather than stored raw: the JWT `exp` gives the ten-minute window a server-side check
 * that does not depend on the browser honouring Max-Age, and a forged cookie cannot pre-agree a
 * state with an attacker-chosen authorization response.
 */
async function sealTransaction(transaction: OidcTransaction): Promise<string> {
  return new SignJWT({ ...transaction })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(TRANSACTION_ISSUER)
    .setAudience(TRANSACTION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${OIDC_TRANSACTION_TTL_SECONDS}s`)
    .sign(transactionKey())
}

export async function openTransaction(token: string | undefined): Promise<OidcTransaction | null> {
  if (token === undefined) return null

  try {
    const { payload } = await jwtVerify(token, transactionKey(), {
      issuer: TRANSACTION_ISSUER,
      audience: TRANSACTION_AUDIENCE,
      algorithms: ['HS256'],
    })
    const { state, nonce, codeVerifier } = payload
    if (typeof state !== 'string') return null
    if (typeof nonce !== 'string') return null
    if (typeof codeVerifier !== 'string') return null
    return { state, nonce, codeVerifier }
  } catch {
    return null
  }
}

function transactionCookie(token: string): string {
  return [
    `${OIDC_TRANSACTION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${TRANSACTION_COOKIE_PATH}`,
    `Max-Age=${OIDC_TRANSACTION_TTL_SECONDS}`,
  ].join('; ')
}

export function clearTransactionCookie(): string {
  const attributes = [
    `${OIDC_TRANSACTION_COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${TRANSACTION_COOKIE_PATH}`,
    'Max-Age=0',
  ]
  return attributes.join('; ')
}

export function readTransactionCookie(request: Request): string | undefined {
  const header = request.headers.get('cookie')
  if (header === null) return undefined

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() !== OIDC_TRANSACTION_COOKIE_NAME) continue
    return decodeURIComponent(pair.slice(separator + 1).trim())
  }
  return undefined
}

export interface AuthorizationRedirect {
  readonly location: string
  readonly setCookie: string
}

export async function startAuthorization(): Promise<AuthorizationRedirect> {
  const configuration = await oidcConfiguration(requireOidcSettings())

  const codeVerifier = client.randomPKCECodeVerifier()
  const transaction: OidcTransaction = {
    state: client.randomState(),
    nonce: client.randomNonce(),
    codeVerifier,
  }

  const authorizationUrl = client.buildAuthorizationUrl(configuration, {
    redirect_uri: oidcRedirectUri(),
    response_type: 'code',
    scope: OIDC_SCOPE,
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state: transaction.state,
    nonce: transaction.nonce,
  })

  return {
    location: authorizationUrl.toString(),
    setCookie: transactionCookie(await sealTransaction(transaction)),
  }
}

/** The registered redirect URI carrying the provider's query string, per RFC 6749 §4.1.3. */
export function callbackUrlFromRequest(request: Request): URL {
  const callbackUrl = new URL(oidcRedirectUri())
  callbackUrl.search = new URL(request.url).search
  return callbackUrl
}

export function stateMatches(returned: string | null, expected: string): boolean {
  if (returned === null) return false

  const returnedBytes = Buffer.from(returned, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (returnedBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(returnedBytes, expectedBytes)
}

export interface OidcIdentity {
  readonly subject: string
  readonly email: string
}

/**
 * Exchanges the code and returns the identity the ID token asserts. `authorizationCodeGrant`
 * verifies the signature plus `iss`, `aud`, `exp` and `nonce`, and rejects a code that was not
 * issued for our PKCE verifier; a failure there throws rather than returning.
 */
export async function exchangeAuthorizationCode(
  callbackUrl: URL,
  transaction: OidcTransaction,
): Promise<OidcIdentity> {
  const configuration = await oidcConfiguration(requireOidcSettings())

  const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
    expectedState: transaction.state,
    expectedNonce: transaction.nonce,
    pkceCodeVerifier: transaction.codeVerifier,
  })

  const claims = tokens.claims()
  if (claims === undefined) throw verificationFailed()

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  if (email === '') throw verificationFailed()
  // Absent means "the provider does not say"; only an explicit false is a refusal.
  if (claims.email_verified === false) throw verificationFailed()

  return { subject: claims.sub, email }
}

export function verificationFailed(): HttpError {
  return new HttpError('VALIDATION_FAILED', OIDC_VERIFICATION_FAILURE, { status: 400 })
}

export type OidcRejection = 'deactivated' | 'email_taken' | 'registration_closed'

export type OidcSigninOutcome =
  | { readonly ok: true; readonly userId: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: OidcRejection }

interface IdentityRow {
  readonly id: string
  readonly isActive: boolean
}

async function findUserByOidcSub(subject: string): Promise<IdentityRow | undefined> {
  const [user] = await db
    .select({ id: users.id, isActive: users.isActive })
    .from(users)
    .where(eq(users.oidcSub, subject))
    .limit(1)
  return user
}

async function isEmailTaken(email: string): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return user !== undefined
}

/**
 * S10 filled the seam this function used to be. Registration is authorised by open registration,
 * or by an outstanding invite naming the address the provider asserted — a link-only invite
 * (`email is null`) cannot authorise it, because nothing would bind the link to this identity.
 */
type RegistrationGrant = { readonly kind: 'open' } | { readonly kind: 'invite'; readonly inviteId: string }

async function oidcRegistrationGrant(email: string): Promise<RegistrationGrant | null> {
  if (env.ALLOW_OPEN_REGISTRATION) return { kind: 'open' }

  const invite = await findRedeemableInviteByEmail(email)
  return invite === null ? null : { kind: 'invite', inviteId: invite.id }
}

function outcomeForExistingUser(user: IdentityRow): OidcSigninOutcome {
  if (!user.isActive) return { ok: false, reason: 'deactivated' }
  return { ok: true, userId: user.id, created: false }
}

async function insertOidcUser(
  identity: OidcIdentity,
  handle: DbHandle,
): Promise<OidcSigninOutcome> {
  const [created] = await handle
    .insert(users)
    .values({
      email: identity.email,
      passwordHash: null,
      oidcSub: identity.subject,
      role: 'member',
      isActive: true,
    })
    .onConflictDoNothing()
    .returning({ id: users.id })

  if (created !== undefined) return { ok: true, userId: created.id, created: true }

  // Lost a race: either a concurrent first sign-in won, or the email was claimed in between.
  const existing = await findUserByOidcSub(identity.subject)
  if (existing === undefined) return { ok: false, reason: 'email_taken' }
  return outcomeForExistingUser(existing)
}

/**
 * The invite claim and the insert share one transaction under the invite's advisory lock, so the
 * invite is burnt exactly when a user is created — never by a sign-in that lost the insert race,
 * and never twice.
 */
async function createOidcUser(
  identity: OidcIdentity,
  grant: RegistrationGrant,
): Promise<OidcSigninOutcome> {
  if (grant.kind === 'open') return insertOidcUser(identity, db)

  return db.transaction(async (transaction) => {
    await lockInvite(transaction, grant.inviteId)
    if (!(await isInviteRedeemable(transaction, grant.inviteId))) {
      return { ok: false, reason: 'registration_closed' }
    }

    const outcome = await insertOidcUser(identity, transaction)
    if (outcome.ok && outcome.created) {
      await claimInvite(transaction, grant.inviteId, outcome.userId)
    }
    return outcome
  })
}

/**
 * The identity key is `oidc_sub` and never the email. An asserted email that already belongs to
 * a password account is refused outright: linking the two must start from the existing account
 * proving itself, otherwise anyone who can make their provider assert an address inherits it.
 */
export async function resolveOidcIdentity(identity: OidcIdentity): Promise<OidcSigninOutcome> {
  const existing = await findUserByOidcSub(identity.subject)
  if (existing !== undefined) return outcomeForExistingUser(existing)

  if (await isEmailTaken(identity.email)) return { ok: false, reason: 'email_taken' }

  const grant = await oidcRegistrationGrant(identity.email)
  if (grant === null) return { ok: false, reason: 'registration_closed' }

  return createOidcUser(identity, grant)
}

const REJECTION_RESPONSES: Readonly<Record<OidcRejection, string>> = {
  deactivated: 'This account cannot sign in',
  email_taken:
    'An account already uses this email address. Sign in with your password to link this provider.',
  registration_closed: 'This instance is invite-only',
}

export function rejectionError(reason: OidcRejection): HttpError {
  return new HttpError('FORBIDDEN', REJECTION_RESPONSES[reason])
}
