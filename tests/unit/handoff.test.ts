import { SignJWT } from 'jose'
import { beforeEach, describe, expect, it } from 'vitest'

import { env } from '@/env'
import {
  consumeHandoffToken,
  forgetConsumedHandoffTokens,
  signHandoffToken,
  type HandoffClaims,
} from '@/lib/handoff'

/** The handoff token contract of grill-result §4.2 step 2, plus the replay rule of §7. */

const CLAIMS: HandoffClaims = {
  artifactId: '11111111-2222-4333-8444-555555555555',
  versionId: '66666666-7777-4888-8999-000000000000',
  viewerRef: 'user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET)
}

async function tokenWith(
  overrides: { issuer?: string; audience?: string; expiresAt?: string; key?: Uint8Array },
): Promise<string> {
  return new SignJWT({ ...CLAIMS })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(overrides.issuer ?? 'enclave')
    .setAudience(overrides.audience ?? 'enclave-artifact-handoff')
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? '30s')
    .sign(overrides.key ?? secretKey())
}

beforeEach(() => {
  forgetConsumedHandoffTokens()
})

describe('handoff token', () => {
  it('round-trips the artifact, version and viewer it is bound to', async () => {
    const token = await signHandoffToken(CLAIMS)
    await expect(consumeHandoffToken(token)).resolves.toEqual(CLAIMS)
  })

  it('is single-use: the second consume is rejected (§7 replay)', async () => {
    const token = await signHandoffToken(CLAIMS)

    await expect(consumeHandoffToken(token)).resolves.toEqual(CLAIMS)
    await expect(consumeHandoffToken(token)).resolves.toBeNull()
  })

  it('burns one token without affecting another', async () => {
    const first = await signHandoffToken(CLAIMS)
    const second = await signHandoffToken(CLAIMS)

    await expect(consumeHandoffToken(first)).resolves.toEqual(CLAIMS)
    await expect(consumeHandoffToken(second)).resolves.toEqual(CLAIMS)
  })

  it('rejects an expired token', async () => {
    await expect(consumeHandoffToken(await tokenWith({ expiresAt: '-1s' }))).resolves.toBeNull()
  })

  it('rejects a token signed with another key', async () => {
    const wrongKey = new TextEncoder().encode('another-secret-that-is-at-least-32-bytes')
    await expect(consumeHandoffToken(await tokenWith({ key: wrongKey }))).resolves.toBeNull()
  })

  it('rejects a session token replayed as a handoff token', async () => {
    const sessionShaped = await tokenWith({ audience: 'enclave-app' })
    await expect(consumeHandoffToken(sessionShaped)).resolves.toBeNull()
  })

  it('rejects another issuer', async () => {
    await expect(consumeHandoffToken(await tokenWith({ issuer: 'someone-else' }))).resolves.toBeNull()
  })

  it('rejects a validly signed token whose claims are incomplete', async () => {
    const token = await new SignJWT({ artifactId: CLAIMS.artifactId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('enclave')
      .setAudience('enclave-artifact-handoff')
      .setJti(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(secretKey())

    await expect(consumeHandoffToken(token)).resolves.toBeNull()
  })

  it.each([['empty', ''], ['garbage', 'not-a-token'], ['a bare uuid', crypto.randomUUID()]])(
    'rejects %s input',
    async (_case, token) => {
      await expect(consumeHandoffToken(token)).resolves.toBeNull()
    },
  )

  it('expires within HANDOFF_TTL_SECONDS of issuance', async () => {
    const token = await signHandoffToken(CLAIMS)
    const payloadSegment = token.split('.')[1] ?? ''
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      iat: number
      exp: number
    }

    expect(payload.exp - payload.iat).toBe(env.HANDOFF_TTL_SECONDS)
  })
})
