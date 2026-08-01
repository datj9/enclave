import { describe, expect, it } from 'vitest'

import {
  resolveManifestPath,
  userIdFromViewerRef,
  userViewerRef,
} from '@/lib/artifacts/authorize'
import type { ManifestEntry } from '@/lib/bundle/validate'

/**
 * The pure half of the read gate. `authorizeArtifactRead` needs Postgres and is covered by
 * tests/e2e/artifact-viewer.spec.ts instead.
 */

const USER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

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
