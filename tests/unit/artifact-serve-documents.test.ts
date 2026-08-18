import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as AuthorizeModule from '@/lib/artifacts/authorize'
import type { ManifestEntry } from '@/lib/bundle/validate'

/**
 * A multi-page artifact reads every page from its own origin, not from a presigned storage URL.
 *
 * The bug this pins: only the entry document was streamed, so a link to a second page redirected
 * the browser onto the storage host. Every relative `href`/`src` on that page then resolved
 * against storage with no signature, which is why the linked page arrived without its stylesheet.
 */

const ARTIFACT_ID = '008d8492-0f60-46f6-a8df-7e27afa083a6'
const VERSION_ID = 'dead3286-0f07-495d-ba76-e4f9727f337c'
const ARTIFACT_HOST = `${ARTIFACT_ID}.artifacts.localhost:3000`
const PRESIGNED_URL = 'https://storage.example.com/bucket/object?X-Amz-Signature=deadbeef'

function manifestEntry(path: string, contentType: string): ManifestEntry {
  return { path, bytes: 128, content_type: contentType, sha256: 'a'.repeat(64) }
}

const MANIFEST: readonly ManifestEntry[] = [
  manifestEntry('index.html', 'text/html'),
  manifestEntry('backend.html', 'text/html'),
  manifestEntry('assets/style.css', 'text/css'),
  manifestEntry('assets/engine.js', 'text/javascript'),
  manifestEntry('data.json', 'application/json'),
  manifestEntry('transcripts/ep35.en.txt', 'text/plain'),
  manifestEntry('notes.md', 'text/markdown'),
  manifestEntry('assets/engine.wasm', 'application/octet-stream'),
]

const getObjectStream = vi.fn()
const presignGetUrl = vi.fn()

vi.mock('@/lib/storage/s3', () => ({
  objectStore: () => ({ getObjectStream, presignGetUrl }),
}))

vi.mock('@/lib/artifacts/grant', () => ({
  GRANT_COOKIE_NAME: 'enclave_grant',
  verifyGrantToken: vi.fn(async () => ({
    artifactId: ARTIFACT_ID,
    versionId: VERSION_ID,
    viewerRef: `user:${ARTIFACT_ID}`,
  })),
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

const { GET, isNavigableDocument } = await import(
  '@app/(artifact)/artifact-origin/[id]/serve/[[...path]]/route'
)

function requestFor(path: string): NextRequest {
  return new NextRequest(`http://${ARTIFACT_HOST}/${path}`, {
    headers: { host: ARTIFACT_HOST, cookie: 'enclave_grant=valid-grant-token' },
  })
}

async function serve(path: string): Promise<Response> {
  // The key is absent, not undefined: that is how the optional catch-all segment actually arrives.
  const params = path === '' ? { id: ARTIFACT_ID } : { id: ARTIFACT_ID, path: path.split('/') }
  return await GET(requestFor(path), { params: Promise.resolve(params) })
}

function streamOf(body: string): ReadableStream<Uint8Array> {
  return new Response(body).body as ReadableStream<Uint8Array>
}

describe('artifact origin document serving', () => {
  beforeEach(() => {
    getObjectStream.mockReset()
    presignGetUrl.mockReset()
    getObjectStream.mockResolvedValue({
      body: streamOf('<!doctype html><link rel="stylesheet" href="assets/style.css">'),
      contentType: 'text/html',
      contentLength: undefined,
    })
    presignGetUrl.mockResolvedValue(PRESIGNED_URL)
  })

  it('streams the entry document at the origin root', async () => {
    const response = await serve('')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('streams a linked HTML page from the artifact origin instead of redirecting off it', async () => {
    const response = await serve('backend.html')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('location')).toBeNull()
    expect(presignGetUrl).not.toHaveBeenCalled()
    expect(getObjectStream).toHaveBeenCalledWith(
      `artifacts/${ARTIFACT_ID}/${VERSION_ID}/backend.html`,
    )
  })

  it('streams a linked .txt transcript from the artifact origin instead of redirecting to storage', async () => {
    const response = await serve('transcripts/ep35.en.txt')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('location')).toBeNull()
    expect(getObjectStream).toHaveBeenCalledWith(
      `artifacts/${ARTIFACT_ID}/${VERSION_ID}/transcripts/ep35.en.txt`,
    )
    expect(presignGetUrl).not.toHaveBeenCalled()
  })

  it('streams JSON and Markdown documents rather than bouncing a navigation off-origin', async () => {
    for (const path of ['data.json', 'notes.md']) {
      const response = await serve(path)

      expect(response.status).toBe(200)
      expect(presignGetUrl).not.toHaveBeenCalled()
    }
  })

  it('isNavigableDocument accepts every browser-renderable type and rejects binary payloads', () => {
    for (const contentType of [
      'text/html',
      'text/plain',
      'Text/HTML; charset=utf-8',
      'application/json',
      'image/svg+xml',
    ]) {
      expect(isNavigableDocument(contentType)).toBe(true)
    }

    for (const contentType of [
      '',
      'application/octet-stream',
      'application/zip',
      'video/mp4',
      'font/woff2',
    ]) {
      expect(isNavigableDocument(contentType)).toBe(false)
    }
  })

  it('still redirects a true binary asset to a presigned URL so bytes bypass the app', async () => {
    const response = await serve('assets/engine.wasm')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(PRESIGNED_URL)
    expect(getObjectStream).not.toHaveBeenCalled()
  })

  it('still redirects non-document assets to a presigned URL so bytes bypass the app', async () => {
    for (const path of ['assets/style.css', 'assets/engine.js']) {
      const response = await serve(path)

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(PRESIGNED_URL)
    }
    expect(getObjectStream).not.toHaveBeenCalled()
  })

  it('404s a path the manifest does not list without touching storage', async () => {
    const response = await serve('secrets.html')

    expect(response.status).toBe(404)
    expect(getObjectStream).not.toHaveBeenCalled()
    expect(presignGetUrl).not.toHaveBeenCalled()
  })
})
