import { eq } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { GET as downloadRouteA } from '@app/a/[id]/download/route'
import { GET as downloadRouteB } from '@app/s/[token]/download/route'
import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { shareLinks } from '@/db/schema/share-links'
import { env } from '@/env'
import { userViewerRef } from '@/lib/artifacts/authorize'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { appendVersion } from '@/lib/artifacts/versions'
import { createShareLink, revokeShareLink } from '@/lib/shares/manage'
import type { BundleFile } from '@/lib/bundle/validate'
import { createTestOwner, createTestStore, probeServices, removeTestOwnerData } from './services'

/**
 * The per-artifact download routes against real Postgres and real object storage, through the
 * actual route handlers. US1, US4, US5, US6 and US7 all live here: the format negotiation, the
 * two auth paths sharing one gate, the oversize cap, and validation-before-auth.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/artifact-download-route: database=${database} storage=${storage}.`,
  )
}

const OWNER_EMAIL = 'download-route-owner@example.test'

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

function bundle(indexHtml: string, appJs = 'console.log(1)'): BundleFile[] {
  return [
    { path: 'index.html', content: Buffer.from(indexHtml, 'utf8') },
    { path: 'app.js', content: Buffer.from(appJs, 'utf8') },
  ]
}

function entryHtml(label: string): string {
  return `<!doctype html><h1>${label}</h1><a href="https://example.com/report">report</a><script src="app.js"></script>`
}

function downloadRequestA(id: string, format: string): NextRequest {
  return new NextRequest(`http://app.example.com/a/${id}/download?format=${format}`)
}

function downloadRequestB(token: string, format: string): NextRequest {
  return new NextRequest(
    `http://app.example.com/s/${encodeURIComponent(token)}/download?format=${format}`,
  )
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

describe.skipIf(!servicesReady)('GET /a/[id]/download', () => {
  let store: ReturnType<typeof createTestStore>
  let ownerId = ''
  let artifactId = ''

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    ownerId = await createTestOwner(OWNER_EMAIL)
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Sales dash', visibility: 'private', files: bundle(entryHtml('Version one')) },
      store,
    )
    artifactId = created.id
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
  })

  it('US1: downloads markdown with a slug filename (200, text/markdown)', async () => {
    const response = await downloadRouteA(downloadRequestA(artifactId, 'md'), {
      params: Promise.resolve({ id: artifactId }),
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="sales-dash.md"',
    )
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    // Turndown of the entry HTML: the <h1> and the <a> survive as markdown.
    expect(body).toContain('Version one')
    expect(body).toContain('[report](https://example.com/report)')
  })

  it('US4: no session on a private artifact is a byte-less 404', async () => {
    mocks.sessionUser = null
    const response = await downloadRouteA(downloadRequestA(artifactId, 'md'), {
      params: Promise.resolve({ id: artifactId }),
    })

    expect(response.status).toBe(404)
    expect(await errorCodeOf(response)).toBe('NOT_FOUND')
    // No bytes of any format reach an unauthorized caller.
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('US5: an anonymous viewer downloads a public artifact (200)', async () => {
    await db
      .update(artifacts)
      .set({ visibility: 'public' })
      .where(eq(artifacts.id, artifactId))
    mocks.sessionUser = null

    const response = await downloadRouteA(downloadRequestA(artifactId, 'md'), {
      params: Promise.resolve({ id: artifactId }),
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="sales-dash.md"',
    )
    expect(body).toContain('Version one')
  })

  it('US7: an unknown format is a 400 before auth, on both readable and unknown ids', async () => {
    const onReadable = await downloadRouteA(downloadRequestA(artifactId, 'zip'), {
      params: Promise.resolve({ id: artifactId }),
    })
    const onUnknown = await downloadRouteA(downloadRequestA('00000000-0000-4000-8000-000000000000', 'zip'), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000000' }),
    })

    for (const response of [onReadable, onUnknown]) {
      expect(response.status).toBe(400)
      expect(await errorCodeOf(response)).toBe('VALIDATION_FAILED')
    }
  })

  it('US6: an oversize manifest is a 413 BUNDLE_TOO_LARGE', async () => {
    // The upload path rejects oversize bundles, so the oversize row is seeded directly — exactly
    // what the ticket prescribes.
    const [version] = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId))
      .limit(1)
    if (version === undefined) throw new Error('expected a seeded version')

    const overTheCap = env.BUNDLE_MAX_TOTAL_BYTES + 1
    await db
      .update(artifactVersions)
      .set({
        manifest: [
          { path: 'index.html', bytes: overTheCap, content_type: 'text/html', sha256: 'fake' },
          { path: 'app.js', bytes: 4, content_type: 'text/javascript', sha256: 'fake' },
        ],
        totalBytes: overTheCap + 4,
      })
      .where(eq(artifactVersions.id, version.id))

    const response = await downloadRouteA(downloadRequestA(artifactId, 'md'), {
      params: Promise.resolve({ id: artifactId }),
    })
    const body = await response.text()

    expect(response.status).toBe(413)
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'BUNDLE_TOO_LARGE' },
    })
  })
})

describe.skipIf(!servicesReady)('GET /s/[token]/download', () => {
  let store: ReturnType<typeof createTestStore>
  let ownerId = ''
  let artifactId = ''
  let pinnedVersionId = ''

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    ownerId = await createTestOwner(OWNER_EMAIL)
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    // v1 is what the link pins; v2 is a newer current version the link must ignore.
    const created = await createArtifactWithBundle(
      { ownerId, title: 'Pinned dash', visibility: 'private', files: bundle(entryHtml('Pinned version')) },
      store,
    )
    artifactId = created.id
    pinnedVersionId = created.versionId
    await appendVersion(
      { artifactId, ownerId, files: bundle(entryHtml('Current version')) },
      store,
    )
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
  })

  it('US5: a valid share link downloads the pinned version as self-contained HTML (200)', async () => {
    const created = await createShareLink({
      artifactId,
      versionId: pinnedVersionId,
      viewerRef: userViewerRef(ownerId),
    })

    const response = await downloadRouteB(downloadRequestB(created.token, 'html'), {
      params: Promise.resolve({ token: created.token }),
    })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="pinned-dash.html"',
    )
    // The pinned v1, not the artifact's current v2.
    expect(body).toContain('Pinned version')
    expect(body).not.toContain('Current version')
    // The manifest-listed script is inlined with its real content type, not left as a relative src.
    expect(body).toContain('<script>console.log(1)</script>')
    expect(body).not.toContain('src="app.js"')
  })

  it('US5: a revoked or expired share token is a 404', async () => {
    const created = await createShareLink({
      artifactId,
      versionId: pinnedVersionId,
      viewerRef: userViewerRef(ownerId),
    })
    const request = downloadRequestB(created.token, 'md')

    await revokeShareLink(created.shareId, userViewerRef(ownerId))

    const revoked = await downloadRouteB(request, {
      params: Promise.resolve({ token: created.token }),
    })
    expect(revoked.status).toBe(404)
    expect(await errorCodeOf(revoked)).toBe('NOT_FOUND')

    // Expiry, judged on the database clock: backdate a fresh link's expires_at directly.
    const second = await createShareLink({
      artifactId,
      versionId: pinnedVersionId,
      viewerRef: userViewerRef(ownerId),
    })
    await db
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(shareLinks.id, second.shareId))

    const expired = await downloadRouteB(downloadRequestB(second.token, 'md'), {
      params: Promise.resolve({ token: second.token }),
    })
    expect(expired.status).toBe(404)
    expect(await errorCodeOf(expired)).toBe('NOT_FOUND')
  })

  it('US7: an unknown format answers 400 even with a valid token (validate before auth)', async () => {
    const created = await createShareLink({
      artifactId,
      versionId: pinnedVersionId,
      viewerRef: userViewerRef(ownerId),
    })
    const response = await downloadRouteB(downloadRequestB(created.token, 'tar'), {
      params: Promise.resolve({ token: created.token }),
    })

    expect(response.status).toBe(400)
    expect(await errorCodeOf(response)).toBe('VALIDATION_FAILED')
  })

  it('US5: an unknown, never-issued token is a 404', async () => {
    // A well-formed 43-char base64url token that no row holds.
    const neverMinted = 'a'.repeat(43)
    const response = await downloadRouteB(downloadRequestB(neverMinted, 'md'), {
      params: Promise.resolve({ token: neverMinted }),
    })

    expect(response.status).toBe(404)
    expect(await errorCodeOf(response)).toBe('NOT_FOUND')
  })
})