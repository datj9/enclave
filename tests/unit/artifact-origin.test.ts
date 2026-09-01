import { describe, expect, it } from 'vitest'

import {
  appOrigin,
  artifactEntryIntent,
  artifactEntryUnavailable,
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

function headersOf(init: Record<string, string> = {}): Headers {
  return new Headers(init)
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

describe('artifactEntryIntent', () => {
  it('classifies Sec-Fetch-Dest: document as a top-level navigation', () => {
    expect(artifactEntryIntent(headersOf({ 'sec-fetch-dest': 'document' }))).toBe('top-level')
  })

  it('classifies Sec-Fetch-Dest: iframe as framed', () => {
    expect(artifactEntryIntent(headersOf({ 'sec-fetch-dest': 'iframe' }))).toBe('framed')
  })

  it('classifies the legacy frame destination as framed', () => {
    expect(artifactEntryIntent(headersOf({ 'sec-fetch-dest': 'frame' }))).toBe('framed')
  })

  it.each(['image', 'style', 'script', 'font', 'empty', 'object', 'audio', 'video'] as const)(
    'classifies every subresource destination as a subresource (%s)',
    (dest) => {
      expect(artifactEntryIntent(headersOf({ 'sec-fetch-dest': dest }))).toBe('subresource')
    },
  )

  it('falls back to framed, not top-level, for an HTML Accept with no Sec-Fetch-Dest', () => {
    expect(
      artifactEntryIntent(
        headersOf({
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        }),
      ),
    ).toBe('framed')
  })

  it('falls back to a subresource for a stylesheet Accept with no Sec-Fetch-Dest', () => {
    expect(artifactEntryIntent(headersOf({ accept: 'text/css,*/*;q=0.1' }))).toBe('subresource')
  })

  it('falls back to a subresource for the wildcard Accept a fetch() sends', () => {
    expect(artifactEntryIntent(headersOf({ accept: '*/*' }))).toBe('subresource')
  })

  it('falls back to a subresource when neither header is present', () => {
    expect(artifactEntryIntent(headersOf())).toBe('subresource')
  })
})

describe('artifactEntryUnavailable', () => {
  it('redirects a top-level navigation to the app-origin viewer page', () => {
    const response = artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'document' }),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`http://localhost:3000/a/${ARTIFACT_ID}`)
  })

  it('sends no-store on the redirect, so a cached bounce cannot outlive the grant', () => {
    const response = artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'document' }),
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('varies on cookie and Sec-Fetch-Dest', () => {
    const response = artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'document' }),
    )
    expect(response.headers.get('vary')).toBe('cookie, sec-fetch-dest, accept')
  })

  it('answers a framed request with a 404 page that links to the viewer', async () => {
    const response = artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'iframe' }),
    )
    expect(response.status).toBe(404)
    const body = await response.text()
    expect(body).toContain(`http://localhost:3000/a/${ARTIFACT_ID}`)
    expect(body).toContain('target="_blank"')
  })

  it('answers a subresource with the unchanged failure page', async () => {
    const response = artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'style' }),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe(await artifactNotAvailable().text())
  })

  it('puts no script and no form in the re-entry page, which the artifact CSP would refuse', async () => {
    const body = await artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'iframe' }),
    ).text()
    expect(body).not.toContain('<script')
    expect(body).not.toContain('<form')
  })

  it('never names the artifact anywhere but in the viewer link', async () => {
    const body = await artifactEntryUnavailable(
      ARTIFACT_ID,
      headersOf({ 'sec-fetch-dest': 'iframe' }),
    ).text()
    expect(body).not.toContain('artifact-origin')
  })
})
