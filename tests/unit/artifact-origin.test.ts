import { describe, expect, it } from 'vitest'

import {
  appOrigin,
  artifactIdFromHost,
  artifactNotAvailable,
  artifactOriginPattern,
  artifactStorageUnavailable,
  requestHost,
} from '@/lib/artifacts/origin'

/**
 * Which host is an artifact origin, and which artifact it is. Getting this wrong is the
 * difference between "one origin per artifact" (§4.1) and every artifact sharing one.
 */

const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555'
const OTHER_ID = '99999999-8888-4777-8666-555555555555'

function requestWithHost(headers: Record<string, string>): Request {
  return new Request('http://example.test/', { headers })
}

describe('artifactIdFromHost', () => {
  it('returns the artifact id for a host matching the template', () => {
    expect(artifactIdFromHost(`${ARTIFACT_ID}.artifacts.localhost:3000`)).toBe(ARTIFACT_ID)
  })

  it('returns a different id for a different subdomain, so two artifacts are two origins', () => {
    expect(artifactIdFromHost(`${OTHER_ID}.artifacts.localhost:3000`)).toBe(OTHER_ID)
  })

  it('accepts an uppercased host, because a Host header is case-insensitive', () => {
    expect(artifactIdFromHost(`${ARTIFACT_ID.toUpperCase()}.artifacts.localhost:3000`)).toBe(
      ARTIFACT_ID,
    )
  })

  it.each([
    ['the app origin', 'localhost:3000'],
    ['a missing host', null],
    ['an empty host', ''],
    ['the right shape with a non-uuid label', 'not-a-uuid.artifacts.localhost:3000'],
    ['a nested label, which would be a second origin level', `a.${ARTIFACT_ID}.artifacts.localhost:3000`],
    ['the wrong port', `${ARTIFACT_ID}.artifacts.localhost:4000`],
    ['a lookalike parent domain', `${ARTIFACT_ID}.artifacts.localhost.evil.test:3000`],
    ['a suffix-only match', `evil${ARTIFACT_ID}x.artifacts.localhost:3000`],
  ])('returns null for %s', (_case, host) => {
    expect(artifactIdFromHost(host)).toBeNull()
  })
})

describe('requestHost', () => {
  it('prefers x-forwarded-host, which is how the app sits behind a reverse proxy', () => {
    const host = requestHost(
      requestWithHost({ host: 'internal:3000', 'x-forwarded-host': 'app.example.test' }),
    )
    expect(host).toBe('app.example.test')
  })

  it('takes the first entry of a forwarded chain', () => {
    const host = requestHost(
      requestWithHost({ host: 'internal:3000', 'x-forwarded-host': 'first.test, second.test' }),
    )
    expect(host).toBe('first.test')
  })

  it('falls back to the Host header', () => {
    expect(requestHost(requestWithHost({ host: 'Localhost:3000' }))).toBe('localhost:3000')
  })
})

describe('CSP source expressions', () => {
  it('names exactly one app origin for frame-ancestors', () => {
    expect(appOrigin()).toBe('http://localhost:3000')
  })

  it('widens the id slot to a wildcard for the app frame-src', () => {
    expect(artifactOriginPattern()).toBe('http://*.artifacts.localhost:3000')
  })
})

describe('artifact-origin failure pages', () => {
  it('is a 404 that names no reason', async () => {
    const response = artifactNotAvailable()
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toContain('no longer available')
  })

  it('is a 503 with no bucket name or stack trace when storage is down', async () => {
    const response = artifactStorageUnavailable()
    expect(response.status).toBe(503)

    const body = await response.text()
    expect(body).toContain('cannot be loaded')
    expect(body).not.toContain('enclave-artifacts')
  })
})
