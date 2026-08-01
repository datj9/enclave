import { SignJWT, jwtVerify } from 'jose'

import { env } from '@/env'

/**
 * The handoff token of grill-result §4.2 step 2: the only thing the artifact origin trusts. It
 * is signed, bound to `{artifactId, versionId, viewerRef}`, lives `HANDOFF_TTL_SECONDS`, and is
 * single-use — a replay must be indistinguishable from a forgery (§7).
 *
 * Never log a token value (§8 log hygiene).
 */

const HANDOFF_ISSUER = 'enclave'

/** Distinct from the session token's audience, so neither can be presented as the other. */
const HANDOFF_AUDIENCE = 'enclave-artifact-handoff'

export interface HandoffClaims {
  readonly artifactId: string
  readonly versionId: string
  readonly viewerRef: string
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET)
}

/**
 * Single use is tracked in process memory rather than a table: the token outlives its own
 * issuance by 30 seconds, so the worst a restart can do is reopen a window narrower than the
 * TTL, and S3 adds no migration. A multi-process deployment needs this moved to Postgres.
 */
const consumedTokenIds = new Map<string, number>()

function markConsumed(tokenId: string, expiresAtMs: number): void {
  const now = Date.now()
  for (const [id, expiresAt] of consumedTokenIds) {
    if (expiresAt <= now) consumedTokenIds.delete(id)
  }
  consumedTokenIds.set(tokenId, expiresAtMs)
}

export async function signHandoffToken(claims: HandoffClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(HANDOFF_ISSUER)
    .setAudience(HANDOFF_AUDIENCE)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${env.HANDOFF_TTL_SECONDS}s`)
    .sign(secretKey())
}

function readClaims(payload: Record<string, unknown>): HandoffClaims | null {
  const { artifactId, versionId, viewerRef } = payload
  if (typeof artifactId !== 'string' || typeof versionId !== 'string') return null
  if (typeof viewerRef !== 'string') return null
  return { artifactId, versionId, viewerRef }
}

/**
 * Verifies and burns the token in one step. `null` covers every rejection — bad signature,
 * wrong audience, expired, malformed, and already used — so no caller can branch on the reason.
 */
export async function consumeHandoffToken(token: string): Promise<HandoffClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: HANDOFF_ISSUER,
      audience: HANDOFF_AUDIENCE,
      algorithms: ['HS256'],
    })

    const claims = readClaims(payload)
    if (claims === null || typeof payload.jti !== 'string' || payload.exp === undefined) return null
    if (consumedTokenIds.has(payload.jti)) return null

    markConsumed(payload.jti, payload.exp * 1000)
    return claims
  } catch {
    return null
  }
}

/** Test seam: the single-use set is process-wide, so a suite has to be able to clear it. */
export function forgetConsumedHandoffTokens(): void {
  consumedTokenIds.clear()
}
