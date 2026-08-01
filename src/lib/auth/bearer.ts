import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'

import { db } from '@/db'
import { apiTokens, type ApiTokenScope } from '@/db/schema/api-tokens'
import { users } from '@/db/schema/users'
import { env } from '@/env'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { requireSessionUser } from '@/lib/api/guards'
import { enforceAuthRateLimit } from './rate-limit-auth'

/**
 * Scoped API tokens, so an external agent can drive `/api/v1` without a browser session
 * (grill-result §5.3, S8). A token acts as its owning user and never more: authorization still
 * runs through the same `canRead` gate, with `apiTokenViewerRef` as the viewer (§5.1).
 *
 * Never log a token value and never put one in an error message (§8 log hygiene). The plaintext
 * exists only inside `createApiToken`'s return value; everything persisted is a SHA-256 digest.
 */

export const API_TOKEN_PREFIX = 'enc_'

const TOKEN_RANDOM_BYTES = 32

/** Separate rate-limit counter from /signin, so agent traffic cannot lock out human sign-in. */
const RATE_LIMIT_SCOPE = 'api-token'

export interface SessionPrincipal {
  readonly kind: 'user'
  readonly userId: string
}

export interface ApiTokenPrincipal {
  readonly kind: 'apiToken'
  readonly userId: string
  readonly tokenId: string
  readonly scopes: readonly ApiTokenScope[]
}

/** What an `/api/v1` route knows about its caller, whichever credential arrived. */
export type ApiPrincipal = SessionPrincipal | ApiTokenPrincipal

export interface CreateApiTokenInput {
  readonly userId: string
  readonly name: string
  readonly scopes: readonly ApiTokenScope[]
  readonly expiresAt?: Date | null
  readonly actorIp?: string | null
}

/** `plaintext` is the one and only time the token value is readable. */
export interface CreatedApiToken {
  readonly id: string
  readonly plaintext: string
  readonly name: string
  readonly scopes: readonly ApiTokenScope[]
  readonly expiresAt: string | null
}

export interface ApiTokenSummary {
  readonly id: string
  readonly name: string
  readonly scopes: readonly ApiTokenScope[]
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly lastUsedAt: string | null
  readonly createdAt: string
}

export function hashApiToken(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext, 'utf8').digest()
}

export function mintApiToken(): { readonly plaintext: string; readonly tokenHash: Buffer } {
  const plaintext = `${API_TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString('base64url')}`
  return { plaintext, tokenHash: hashApiToken(plaintext) }
}

/** `null` for a missing header, a non-bearer scheme, or an empty credential. */
export function bearerTokenFromHeaders(headers: Headers): string | null {
  const authorization = headers.get('authorization')
  if (authorization === null) return null

  const separator = authorization.indexOf(' ')
  if (separator === -1) return null
  if (authorization.slice(0, separator).toLowerCase() !== 'bearer') return null

  const credential = authorization.slice(separator + 1).trim()
  return credential === '' ? null : credential
}

export async function createApiToken(input: CreateApiTokenInput): Promise<CreatedApiToken> {
  const { plaintext, tokenHash } = mintApiToken()
  const expiresAt = input.expiresAt ?? null

  const [row] = await db
    .insert(apiTokens)
    .values({
      userId: input.userId,
      name: input.name,
      tokenHash,
      scopes: [...input.scopes],
      expiresAt,
    })
    .returning({ id: apiTokens.id })

  if (row === undefined) throw new HttpError('INTERNAL_ERROR', 'Could not create the token')

  recordAuditEvent({
    action: 'token.create',
    actorUserId: input.userId,
    actorIp: input.actorIp ?? null,
    metadata: { tokenId: row.id, name: input.name, scopes: input.scopes },
  })

  return {
    id: row.id,
    plaintext,
    name: input.name,
    scopes: input.scopes,
    expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
  }
}

/** Never selects `token_hash`: the list must not expose anything derived from the secret. */
export async function listApiTokens(userId: string): Promise<readonly ApiTokenSummary[]> {
  const rows = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scopes: apiTokens.scopes,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }))
}

/**
 * `false` covers both "no such token" and "belongs to someone else", so a caller cannot probe
 * for another user's token ids. Revoking an already-revoked token keeps the first timestamp.
 */
export async function revokeApiToken(
  userId: string,
  tokenId: string,
  actorIp?: string | null,
): Promise<boolean> {
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id })

  if (revoked.length === 0) return await isOwnedToken(userId, tokenId)

  recordAuditEvent({
    action: 'token.revoke',
    actorUserId: userId,
    actorIp: actorIp ?? null,
    metadata: { tokenId },
  })
  return true
}

async function isOwnedToken(userId: string, tokenId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: apiTokens.id })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .limit(1)

  return row !== undefined
}

/**
 * `null` for every rejection — unknown, revoked, expired, or owned by a deactivated user — so no
 * caller can branch on the reason and no response can confirm that a token ever existed.
 *
 * Expiry is compared in Postgres `now()`, never app-server time (§7 clock skew).
 */
export async function resolveApiToken(plaintext: string): Promise<ApiTokenPrincipal | null> {
  if (!plaintext.startsWith(API_TOKEN_PREFIX)) return null

  const [row] = await db
    .select({ id: apiTokens.id, userId: apiTokens.userId, scopes: apiTokens.scopes })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, hashApiToken(plaintext)),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, sql`now()`)),
        eq(users.isActive, true),
      ),
    )
    .limit(1)

  if (row === undefined) return null

  await db.update(apiTokens).set({ lastUsedAt: sql`now()` }).where(eq(apiTokens.id, row.id))

  return { kind: 'apiToken', userId: row.userId, tokenId: row.id, scopes: row.scopes }
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * HTTPS is terminated at a proxy in every supported deployment, so `x-forwarded-proto` is the
 * authority and the request's own scheme is only the fallback for a direct connection.
 *
 * A loopback request never leaves the machine, so plaintext there exposes the token to nobody —
 * that exemption is what lets a local instance and the e2e suite run over http.
 */
export function isPlaintextTransport(request: Request): boolean {
  const url = new URL(request.url)
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return false

  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return (forwardedProto ?? url.protocol.replace(':', '')) !== 'https'
}

/**
 * The auth gate for every `/api/v1` route that accepts either credential. A bearer header is
 * never allowed to fall back to the session cookie: a revoked token must 401 even when the same
 * agent happens to hold a valid cookie.
 *
 * A session principal carries no scopes — a signed-in user is already allowed everything a token
 * of theirs could be granted.
 */
export async function requireApiPrincipal(
  request: Request,
  requiredScope: ApiTokenScope,
): Promise<ApiPrincipal> {
  const bearerToken = bearerTokenFromHeaders(request.headers)
  if (bearerToken === null) return { kind: 'user', userId: (await requireSessionUser()).id }

  // A plaintext hop in production means the token already crossed the network in the clear
  // (§8, A.10.1.1). Development runs over http on localhost, so the refusal is production-only.
  if (env.NODE_ENV === 'production' && isPlaintextTransport(request)) {
    throw new HttpError('FORBIDDEN', 'API tokens require an HTTPS request')
  }

  const principal = await resolveApiToken(bearerToken)
  if (principal === null) {
    // Only failures consume the per-IP budget, so a working agent is never throttled by it.
    enforceAuthRateLimit(request, RATE_LIMIT_SCOPE)
    throw new HttpError('UNAUTHENTICATED', 'The API token is not valid')
  }

  if (!principal.scopes.includes(requiredScope)) {
    throw new HttpError('FORBIDDEN', `Token lacks scope ${requiredScope}`)
  }

  return principal
}
