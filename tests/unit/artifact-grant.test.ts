import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { env } from '@/env'
import {
  GRANT_COOKIE_NAME,
  createGrantCookie,
  verifyGrantToken,
  type NewArtifactGrant,
} from '@/lib/artifacts/grant'

/** The grant cookie of grill-result §4.2 step 4, and the host check of §7. */

const ARTIFACT_A = '11111111-2222-4333-8444-555555555555'
const ARTIFACT_B = '99999999-8888-4777-8666-555555555555'

const GRANT: NewArtifactGrant = {
  artifactId: ARTIFACT_A,
  versionId: '66666666-7777-4888-8999-000000000000',
  viewerRef: 'user:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
}

function tokenFrom(setCookie: string): string {
  return setCookie.slice(`${GRANT_COOKIE_NAME}=`.length).split(';')[0] ?? ''
}

describe('createGrantCookie', () => {
  it('sets no Domain, which is what scopes it to one artifact subdomain', async () => {
    const setCookie = await createGrantCookie(GRANT)

    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toContain(`Max-Age=${env.ARTIFACT_GRANT_TTL_SECONDS}`)
    expect(setCookie).not.toContain('Domain')
  })

  /** See the note on `createGrantCookie`: Lax is refused by the browser in a cross-site frame. */
  it('is SameSite=None, because /__enter is a cross-site subframe navigation', async () => {
    const setCookie = await createGrantCookie(GRANT)

    expect(setCookie).toContain('SameSite=None')
    // SameSite=None is only honoured alongside Secure.
    expect(setCookie).toContain('Secure')
  })

  it('mints a distinct grantId per cookie', async () => {
    const first = await verifyGrantToken(tokenFrom(await createGrantCookie(GRANT)), ARTIFACT_A)
    const second = await verifyGrantToken(tokenFrom(await createGrantCookie(GRANT)), ARTIFACT_A)

    expect(first?.grantId).not.toBe(second?.grantId)
  })

  it('expires within ARTIFACT_GRANT_TTL_SECONDS of issuance', async () => {
    const segment = tokenFrom(await createGrantCookie(GRANT)).split('.')[1] ?? ''
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as {
      iat: number
      exp: number
    }

    expect(payload.exp - payload.iat).toBe(env.ARTIFACT_GRANT_TTL_SECONDS)
  })
})

describe('verifyGrantToken', () => {
  it('accepts the cookie on the host it was minted for', async () => {
    const grant = await verifyGrantToken(tokenFrom(await createGrantCookie(GRANT)), ARTIFACT_A)

    expect(grant?.artifactId).toBe(ARTIFACT_A)
    expect(grant?.versionId).toBe(GRANT.versionId)
    expect(grant?.viewerRef).toBe(GRANT.viewerRef)
  })

  it("rejects artifact A's cookie presented on artifact B's host (§7)", async () => {
    const token = tokenFrom(await createGrantCookie(GRANT))
    await expect(verifyGrantToken(token, ARTIFACT_B)).resolves.toBeNull()
  })

  it('rejects a handoff token presented as a grant cookie', async () => {
    const handoffShaped = await new SignJWT({ ...GRANT, grantId: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('enclave')
      .setAudience('enclave-artifact-handoff')
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(new TextEncoder().encode(env.SESSION_SECRET))

    await expect(verifyGrantToken(handoffShaped, ARTIFACT_A)).resolves.toBeNull()
  })

  it('rejects a token signed with another key', async () => {
    const forged = await new SignJWT({ ...GRANT, grantId: crypto.randomUUID() })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('enclave')
      .setAudience('enclave-artifact-grant')
      .setIssuedAt()
      .setExpirationTime('1800s')
      .sign(new TextEncoder().encode('another-secret-that-is-at-least-32-bytes'))

    await expect(verifyGrantToken(forged, ARTIFACT_A)).resolves.toBeNull()
  })

  it.each([['empty', ''], ['garbage', 'not-a-token']])('rejects %s input', async (_case, token) => {
    await expect(verifyGrantToken(token, ARTIFACT_A)).resolves.toBeNull()
  })
})
