import { SignJWT, jwtVerify } from 'jose'

import { env } from '@/env'

/**
 * The grant cookie of grill-result §4.2 step 4. Written by `/__enter` on one artifact subdomain
 * and read back by that subdomain's routes.
 *
 * Two things keep it scoped to a single artifact: no `Domain` attribute, so the browser only
 * ever sends it back to the exact host that set it; and `artifactId` in the payload, checked
 * against the request host by `verifyGrantToken` so a stolen cookie replayed on another
 * artifact's host is rejected server-side too (§7).
 *
 * Never log a cookie value (§8 log hygiene).
 */

export const GRANT_COOKIE_NAME = 'enclave_grant'

const GRANT_ISSUER = 'enclave'
const GRANT_AUDIENCE = 'enclave-artifact-grant'

export interface ArtifactGrant {
  readonly artifactId: string
  readonly versionId: string
  readonly grantId: string
  /**
   * Beyond the `{artifactId, versionId, grantId}` payload §4.2 names. Step 5 re-checks
   * authorization on every document request, and without the viewer's identity on the artifact
   * origin — which has no session — there is nothing to re-check against.
   */
  readonly viewerRef: string
}

export type NewArtifactGrant = Omit<ArtifactGrant, 'grantId'>

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET)
}

/**
 * The `Set-Cookie` value. `Secure` is unconditional — Chrome permits it on `*.localhost`, so the
 * flow is testable without TLS.
 *
 * §4.2 asks for `SameSite=Lax`; that value cannot work and is the one place this slice departs
 * from it. `/__enter` is a **cross-site subframe** navigation whenever the artifact origin is not
 * a sibling of the app origin — which is both §4.1's *recommended* separate-registrable-domain
 * topology and the shipped local one (`localhost` vs `artifacts.localhost` are different
 * registrable domains). Chrome refuses the cookie there with `blockedReasons: ["SameSiteLax"]`.
 *
 * Nothing is lost: `SameSite` was never what isolated this cookie. Host-only scope plus the
 * `artifactId` payload check in `verifyGrantToken` are, and the artifact origin has no
 * state-changing endpoint for `SameSite` to protect — it is GET-only with `form-action 'none'`.
 * The app origin's session cookie stays `SameSite=Lax`.
 */
export async function createGrantCookie(grant: NewArtifactGrant): Promise<string> {
  const token = await new SignJWT({ ...grant, grantId: crypto.randomUUID() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(GRANT_ISSUER)
    .setAudience(GRANT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ARTIFACT_GRANT_TTL_SECONDS}s`)
    .sign(secretKey())

  return [
    `${GRANT_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Path=/',
    `Max-Age=${env.ARTIFACT_GRANT_TTL_SECONDS}`,
  ].join('; ')
}

function readGrant(payload: Record<string, unknown>): ArtifactGrant | null {
  const { artifactId, versionId, grantId, viewerRef } = payload
  if (typeof artifactId !== 'string' || typeof versionId !== 'string') return null
  if (typeof grantId !== 'string' || typeof viewerRef !== 'string') return null
  return { artifactId, versionId, grantId, viewerRef }
}

/**
 * `expectedArtifactId` is the id parsed from the request `Host`. A cookie minted for artifact A
 * and presented on artifact B's host fails here, exactly as it fails at the browser.
 */
export async function verifyGrantToken(
  token: string,
  expectedArtifactId: string,
): Promise<ArtifactGrant | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: GRANT_ISSUER,
      audience: GRANT_AUDIENCE,
      algorithms: ['HS256'],
    })

    const grant = readGrant(payload)
    return grant !== null && grant.artifactId === expectedArtifactId ? grant : null
  } catch {
    return null
  }
}
