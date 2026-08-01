import { describe, expect, it } from 'vitest'

import {
  resolveManifestPath,
  shareLinkIdFromViewerRef,
  shareViewerRef,
  userIdFromViewerRef,
  userViewerRef,
} from '@/lib/artifacts/authorize'
import type { ManifestEntry } from '@/lib/bundle/validate'

/**
 * The pure half of the read gate. `authorizeArtifactRead` needs Postgres and is covered by
 * tests/e2e/artifact-viewer.spec.ts instead.
 */

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SHARE_LINK_ID = 'c8d2c8d2-1111-4111-8111-c8d2c8d2c8d2'

function entry(path: string): ManifestEntry {
  return { path, bytes: 1, content_type: 'text/javascript', sha256: 'x' }
}

const MANIFEST: readonly ManifestEntry[] = [
  entry('index.html'),
  entry('assets/app.js'),
  entry('data.json'),
]

describe('viewer refs', () => {
  it('round-trips a user id', () => {
    expect(userIdFromViewerRef(userViewerRef(USER_ID))).toBe(USER_ID)
  })

  it.each([
    ['an unknown kind', 'share:abc'],
    ['a bare id', USER_ID],
    ['a non-uuid user', 'user:not-a-uuid'],
    ['an empty ref', ''],
  ])('returns null for %s', (_case, viewerRef) => {
    expect(userIdFromViewerRef(viewerRef)).toBeNull()
  })

  it('round-trips a share link id', () => {
    expect(shareLinkIdFromViewerRef(shareViewerRef(SHARE_LINK_ID))).toBe(SHARE_LINK_ID)
  })

  it('carries the link id, never the token — a ref reaches the artifact origin', () => {
    expect(shareViewerRef(SHARE_LINK_ID)).toBe(`share:${SHARE_LINK_ID}`)
  })

  it.each([
    ['a user ref', userViewerRef(USER_ID)],
    ['a non-uuid share id', 'share:not-a-uuid'],
    ['a bare id', SHARE_LINK_ID],
    ['an empty ref', ''],
  ])('resolves no share link id from %s', (_case, viewerRef) => {
    expect(shareLinkIdFromViewerRef(viewerRef)).toBeNull()
  })

  it('keeps the two ref kinds from resolving as each other', () => {
    expect(userIdFromViewerRef(shareViewerRef(SHARE_LINK_ID))).toBeNull()
    expect(shareLinkIdFromViewerRef(userViewerRef(USER_ID))).toBeNull()
  })
})

describe('resolveManifestPath', () => {
  it('matches a listed path exactly', () => {
    expect(resolveManifestPath(MANIFEST, 'assets/app.js')?.path).toBe('assets/app.js')
  })

  it.each([
    ['a path not in the manifest', 'assets/missing.js'],
    ['a leading slash', '/assets/app.js'],
    ['a directory prefix of a listed path', 'assets'],
    ['a trailing slash', 'assets/app.js/'],
    ['a case variant', 'Assets/App.js'],
    ['a traversal', 'assets/../data.json'],
    ['an encoded traversal', 'assets%2F..%2Fdata.json'],
    ['a query-looking suffix', 'data.json?v=2'],
  ])('returns null for %s, before any storage call', (_case, path) => {
    expect(resolveManifestPath(MANIFEST, path)).toBeNull()
  })

  it('returns null against an empty manifest', () => {
    expect(resolveManifestPath([], 'index.html')).toBeNull()
  })
})
