import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AuthorizeModule from '@/lib/artifacts/authorize'
import type { ManifestEntry } from '@/lib/bundle/validate'

/**
 * Route-level coverage for direct artifact entry (CHG-2 / CHG-3): navigate vs framed vs
 * subresource on a grant miss, the loop guard that keeps authorization-informed failures on
 * the bare 404, and the existence-oracle invariant that nothing consults Postgres before a
 * redirect.
 */

const ARTIFACT_ID = '008d8492-0f60-46f6-a8df-7e27afa083a6'
const OTHER_ID = '11111111-2222-4333-8444-555555555555'
const VERSION_ID = 'dead3286-0f07-495d-ba76-e4f9727f337c'
const OTHER_VERSION_ID = 'beef3286-0f07-495d-ba76-e4f9727f337c'
const ARTIFACT_HOST = `${ARTIFACT_ID}.artifacts.localhost:3000`
const OTHER_HOST = `${OTHER_ID}.artifacts.localhost:3000`
const VIEWER_URL = `http://localhost:3000/a/${ARTIFACT_ID}`
const VIEWER_REF = `user:${ARTIFACT_ID}`

function manifestEntry(path: string, contentType: string): ManifestEntry {
  return { path, bytes: 128, content_type: contentType, sha256: 'a'.repeat(64) }
}

const MANIFEST: readonly ManifestEntry[] = [
  manifestEntry('index.html', 'text/html'),
  manifestEntry('assets/style.css', 'text/css'),
]

const getObjectStream = vi.fn()
const presignGetUrl = vi.fn()
const verifyGrantToken = vi.fn()
const createGrantCookie = vi.fn()
const consumeHandoffToken = vi.fn()
const recordAuditEvent = vi.fn()
const recordShareLinkView = vi.fn()

vi.mock('@/lib/storage/s3', () => ({
  objectStore: () => ({ getObjectStream, presignGetUrl }),
}))

vi.mock('@/lib/artifacts/grant', () => ({
  GRANT_COOKIE_NAME: 'enclave_grant',
  verifyGrantToken,
  createGrantCookie,
}))

vi.mock('@/lib/artifacts/authorize', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthorizeModule>()
  return {
    ...actual,
    authorizeArtifactRead: vi.fn(async () => ({
      artifactId: ARTIFACT_ID,
      versionId: VERSION_ID,
      entryPath: 'index.html',
      manifest: MANIFEST,
      visibility: 'private' as const,
      isOwner: true,
    })),
  }
})

vi.mock('@/lib/handoff', () => ({
  consumeHandoffToken,
}))

vi.mock('@/lib/audit', () => ({
  recordAuditEvent,
}))

vi.mock('@/lib/shares/links', () => ({
  recordShareLinkView,
}))

const { GET: serveGet } = await import(
  '@app/(artifact)/artifact-origin/[id]/serve/[[...path]]/route'
)
const { GET: enterGet } = await import('@app/(artifact)/artifact-origin/[id]/enter/route')
const { authorizeArtifactRead } = await import('@/lib/artifacts/authorize')

function grantClaims() {
  return {
    artifactId: ARTIFACT_ID,
    versionId: VERSION_ID,
    viewerRef: VIEWER_REF,
  }
}

function authorizedVersion(overrides: { versionId?: string } = {}) {
  return {
    artifactId: ARTIFACT_ID,
    versionId: overrides.versionId ?? VERSION_ID,
    entryPath: 'index.html',
    manifest: MANIFEST,
    visibility: 'private' as const,
    isOwner: true,
  }
}

async function serve(
  path: string,
  headers: Record<string, string>,
  options: { readonly id?: string; readonly host?: string } = {},
): Promise<Response> {
  const id = options.id ?? ARTIFACT_ID
  const host = options.host ?? ARTIFACT_HOST
  const pathname = path === '' ? '/' : `/${path}`
  const request = new NextRequest(`http://${host}${pathname}`, {
    headers: { host, ...headers },
  })
  const params = path === '' ? { id } : { id, path: path.split('/') }
  return await serveGet(request, { params: Promise.resolve(params) })
}

async function enter(
  headers: Record<string, string>,
  options: { readonly token?: string } = {},
): Promise<Response> {
  const url =
    options.token === undefined
      ? `http://${ARTIFACT_HOST}/__enter`
      : `http://${ARTIFACT_HOST}/__enter?t=${encodeURIComponent(options.token)}`
  const request = new NextRequest(url, {
    headers: { host: ARTIFACT_HOST, ...headers },
  })
  return await enterGet(request, { params: Promise.resolve({ id: ARTIFACT_ID }) })
}

describe('/serve without a usable grant', () => {
  beforeEach(() => {
    getObjectStream.mockReset()
    presignGetUrl.mockReset()
    verifyGrantToken.mockReset()
    createGrantCookie.mockReset()
    vi.mocked(authorizeArtifactRead).mockReset()
    vi.mocked(authorizeArtifactRead).mockResolvedValue(authorizedVersion())
    verifyGrantToken.mockResolvedValue(grantClaims())
    createGrantCookie.mockResolvedValue('enclave_grant=minted; Path=/; HttpOnly')
  })

  it('redirects a top-level navigation with no grant cookie to the viewer page', async () => {
    const response = await serve('', { 'sec-fetch-dest': 'document' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(VIEWER_URL)
  })

  it('redirects a top-level navigation whose grant cookie has expired', async () => {
    verifyGrantToken.mockResolvedValue(null)

    const response = await serve('', {
      'sec-fetch-dest': 'document',
      cookie: 'enclave_grant=expired-grant-token',
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(VIEWER_URL)
  })

  it('answers the framed entry with a 404 re-entry page rather than a redirect', async () => {
    const response = await serve('', { 'sec-fetch-dest': 'iframe' })

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
    await expect(response.text()).resolves.toContain(`/a/${ARTIFACT_ID}`)
  })

  it('keeps a stylesheet subresource on the unchanged 404', async () => {
    const response = await serve('', { 'sec-fetch-dest': 'style' })

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
    await expect(response.text()).resolves.not.toContain('/a/')
  })

  it('keeps a fetch() from artifact JavaScript on the unchanged 404', async () => {
    const response = await serve('', { 'sec-fetch-dest': 'empty' })

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
    await expect(response.text()).resolves.not.toContain('/a/')
  })

  it('redirects a deep path to the artifact root, carrying no path', async () => {
    const response = await serve('deep/page.html', { 'sec-fetch-dest': 'document' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(VIEWER_URL)
  })

  it('asks the database nothing before redirecting', async () => {
    const response = await serve('', { 'sec-fetch-dest': 'document' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(VIEWER_URL)
    expect(authorizeArtifactRead).not.toHaveBeenCalled()
    expect(getObjectStream).not.toHaveBeenCalled()
  })
})

describe('/serve loop guard', () => {
  beforeEach(() => {
    getObjectStream.mockReset()
    presignGetUrl.mockReset()
    verifyGrantToken.mockReset()
    createGrantCookie.mockReset()
    vi.mocked(authorizeArtifactRead).mockReset()
    verifyGrantToken.mockResolvedValue(grantClaims())
    vi.mocked(authorizeArtifactRead).mockResolvedValue(authorizedVersion())
    createGrantCookie.mockResolvedValue('enclave_grant=minted; Path=/; HttpOnly')
  })

  it('keeps a refused authorization on the 404, so a redirect cannot bounce a refused viewer', async () => {
    vi.mocked(authorizeArtifactRead).mockResolvedValue(null)

    const response = await serve('', {
      'sec-fetch-dest': 'document',
      cookie: 'enclave_grant=valid-grant-token',
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps a version mismatch on the 404', async () => {
    vi.mocked(authorizeArtifactRead).mockResolvedValue(
      authorizedVersion({ versionId: OTHER_VERSION_ID }),
    )

    const response = await serve('', {
      'sec-fetch-dest': 'document',
      cookie: 'enclave_grant=valid-grant-token',
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps a manifest miss on the 404 even for a top-level navigation', async () => {
    const response = await serve('secrets.html', {
      'sec-fetch-dest': 'document',
      cookie: 'enclave_grant=valid-grant-token',
    })

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps a host that does not match the route param on the 404', async () => {
    const response = await serve(
      '',
      { 'sec-fetch-dest': 'document' },
      { id: ARTIFACT_ID, host: OTHER_HOST },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })
})

describe('/__enter without a usable token', () => {
  beforeEach(() => {
    consumeHandoffToken.mockReset()
    createGrantCookie.mockReset()
    recordAuditEvent.mockReset()
    recordShareLinkView.mockReset()
    vi.mocked(authorizeArtifactRead).mockReset()
    vi.mocked(authorizeArtifactRead).mockResolvedValue(authorizedVersion())
    consumeHandoffToken.mockResolvedValue(null)
    createGrantCookie.mockResolvedValue('enclave_grant=minted; Path=/; HttpOnly')
  })

  it('redirects a top-level entry with no token to the viewer page', async () => {
    const response = await enter({ 'sec-fetch-dest': 'document' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(VIEWER_URL)
  })

  it('redirects a replayed token top-level instead of dead-ending', async () => {
    consumeHandoffToken.mockResolvedValue(null)

    const response = await enter(
      { 'sec-fetch-dest': 'document' },
      { token: 'already-burnt-token' },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(VIEWER_URL)
  })

  it('answers a replayed token inside the frame with the re-entry page, not a redirect', async () => {
    consumeHandoffToken.mockResolvedValue(null)

    const response = await enter(
      { 'sec-fetch-dest': 'iframe' },
      { token: 'already-burnt-token' },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('still burns the token before deciding', async () => {
    consumeHandoffToken.mockResolvedValue(null)

    await enter({ 'sec-fetch-dest': 'document' }, { token: 'already-burnt-token' })

    expect(consumeHandoffToken).toHaveBeenCalledTimes(1)
  })

  it('keeps a refused authorization on the 404 after a valid token', async () => {
    consumeHandoffToken.mockResolvedValue(grantClaims())
    vi.mocked(authorizeArtifactRead).mockResolvedValue(null)

    const response = await enter(
      { 'sec-fetch-dest': 'document' },
      { token: 'fresh-handoff-token' },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  })

  it('sets no grant cookie on any of these responses', async () => {
    const noToken = await enter({ 'sec-fetch-dest': 'document' })
    expect(noToken.headers.get('set-cookie')).toBeNull()

    consumeHandoffToken.mockResolvedValue(null)
    const replayed = await enter(
      { 'sec-fetch-dest': 'document' },
      { token: 'already-burnt-token' },
    )
    expect(replayed.headers.get('set-cookie')).toBeNull()

    const framed = await enter(
      { 'sec-fetch-dest': 'iframe' },
      { token: 'already-burnt-token' },
    )
    expect(framed.headers.get('set-cookie')).toBeNull()

    consumeHandoffToken.mockResolvedValue(grantClaims())
    vi.mocked(authorizeArtifactRead).mockResolvedValue(null)
    const refused = await enter(
      { 'sec-fetch-dest': 'document' },
      { token: 'fresh-handoff-token' },
    )
    expect(refused.headers.get('set-cookie')).toBeNull()
  })
})
