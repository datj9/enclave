import type { NextRequest } from 'next/server'

import { env } from '@/env'
import {
  authorizeArtifactRead,
  resolveManifestPath,
  type AuthorizedVersion,
} from '@/lib/artifacts/authorize'
import { GRANT_COOKIE_NAME, verifyGrantToken } from '@/lib/artifacts/grant'
import {
  artifactEntryUnavailable,
  artifactIdFromHost,
  artifactNotAvailable,
  artifactStorageUnavailable,
  requestHost,
} from '@/lib/artifacts/origin'
import type { ManifestEntry } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'
import { storageKey } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * grill-result §4.2 steps 5 and 6, the whole read surface of an artifact origin.
 *
 * Documents stream through this process, so revoking access takes effect on the next request and
 * every page of a multi-page artifact keeps this origin as its base URL. Every other content type
 * is redirected to a freshly minted presigned URL, which is why asset bytes never touch the app.
 * Neither the presigned URL nor the grant cookie is logged.
 */

export const dynamic = 'force-dynamic'

const NO_STORE = 'private, no-store'

/**
 * The content types a browser can *navigate* to, which is what makes them this origin's to serve.
 * Streaming these keeps the navigation on-origin; every other type redirects to a presigned URL.
 */
const NAVIGABLE_DOCUMENT_TYPES = new Set([
  'text/html',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/xml',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/pdf',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/** True when the content type names something a browser renders in a top-level navigation. */
export function isNavigableDocument(contentType: string): boolean {
  const normalised = (contentType.toLowerCase().split(';')[0] ?? '').trim()
  return NAVIGABLE_DOCUMENT_TYPES.has(normalised)
}

interface RouteContext {
  readonly params: Promise<{ readonly id: string; readonly path?: readonly string[] }>
}

async function streamDocument(
  version: AuthorizedVersion,
  entry: ManifestEntry,
): Promise<Response> {
  const key = storageKey(version.artifactId, version.versionId, entry.path)
  const object = await objectStore().getObjectStream(key)
  if (object === undefined) return artifactNotAvailable()

  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': `${entry.content_type}; charset=utf-8`,
      'cache-control': NO_STORE,
      ...(object.contentLength === undefined
        ? {}
        : { 'content-length': String(object.contentLength) }),
    },
  })
}

async function redirectToAsset(
  version: AuthorizedVersion,
  entry: ManifestEntry,
): Promise<Response> {
  const signedUrl = await objectStore().presignGetUrl(
    storageKey(version.artifactId, version.versionId, entry.path),
    env.PRESIGN_TTL_SECONDS,
  )

  return new Response(null, {
    status: 302,
    headers: { location: signedUrl, 'cache-control': NO_STORE },
  })
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  const hostArtifactId = artifactIdFromHost(requestHost(request))
  const { id, path } = await context.params
  if (hostArtifactId === null || hostArtifactId !== id) return artifactNotAvailable()

  const cookie = request.cookies.get(GRANT_COOKIE_NAME)?.value
  // §5.1: must sit strictly above authorizeArtifactRead — no Postgres yet, so this answer is
  // identical for an artifact that exists and one that never did.
  if (cookie === undefined) return artifactEntryUnavailable(hostArtifactId, request.headers)

  const grant = await verifyGrantToken(cookie, hostArtifactId)
  // §5.1: same invariant as the no-cookie branch — HMAC only, no database.
  if (grant === null) return artifactEntryUnavailable(hostArtifactId, request.headers)

  const authorized = await authorizeArtifactRead(grant.artifactId, grant.viewerRef)
  if (authorized === null || authorized.versionId !== grant.versionId) {
    return artifactNotAvailable()
  }

  const requestedPath = (path ?? []).join('/')
  // `/` and an explicit `/index.html` name the same document and must take the same branch.
  const entry = resolveManifestPath(
    authorized.manifest,
    requestedPath === '' ? authorized.entryPath : requestedPath,
  )
  // Deliberately before any storage call: an unlisted path costs the bucket nothing.
  if (entry === null) return artifactNotAvailable()

  try {
    // Kind, not position. A navigation redirected to storage would re-base the page there, and
    // its relative hrefs would then be fetched unsigned.
    return isNavigableDocument(entry.content_type)
      ? await streamDocument(authorized, entry)
      : await redirectToAsset(authorized, entry)
  } catch (error) {
    if (error instanceof HttpError && error.code === 'STORAGE_UNAVAILABLE') {
      return artifactStorageUnavailable()
    }
    throw error
  }
}
