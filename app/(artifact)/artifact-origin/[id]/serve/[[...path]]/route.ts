import type { NextRequest } from 'next/server'

import { env } from '@/env'
import {
  authorizeArtifactRead,
  resolveManifestPath,
  type AuthorizedVersion,
} from '@/lib/artifacts/authorize'
import { GRANT_COOKIE_NAME, verifyGrantToken } from '@/lib/artifacts/grant'
import {
  artifactIdFromHost,
  artifactNotAvailable,
  artifactStorageUnavailable,
  requestHost,
} from '@/lib/artifacts/origin'
import { HttpError } from '@/lib/http'
import { storageKey } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'

/**
 * grill-result §4.2 steps 5 and 6, the whole read surface of an artifact origin.
 *
 * `/` streams the entry document through this process so revoking access takes effect on the
 * next request; every other path is redirected to a freshly minted presigned URL, which is why
 * asset bytes never touch the app. Neither the presigned URL nor the grant cookie is logged.
 */

export const dynamic = 'force-dynamic'

const NO_STORE = 'private, no-store'

interface RouteContext {
  readonly params: Promise<{ readonly id: string; readonly path?: readonly string[] }>
}

async function streamEntryDocument(version: AuthorizedVersion): Promise<Response> {
  const entry = resolveManifestPath(version.manifest, version.entryPath)
  const key = storageKey(version.artifactId, version.versionId, version.entryPath)
  const object = await objectStore().getObjectStream(key)
  if (object === undefined) return artifactNotAvailable()

  const contentType = entry?.content_type ?? object.contentType
  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': contentType.startsWith('text/') ? `${contentType}; charset=utf-8` : contentType,
      'cache-control': NO_STORE,
      ...(object.contentLength === undefined
        ? {}
        : { 'content-length': String(object.contentLength) }),
    },
  })
}

async function redirectToAsset(
  version: AuthorizedVersion,
  requestedPath: string,
): Promise<Response> {
  const entry = resolveManifestPath(version.manifest, requestedPath)
  // Deliberately before any storage call: an unlisted path costs the bucket nothing.
  if (entry === null) return artifactNotAvailable()

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
  if (cookie === undefined) return artifactNotAvailable()

  const grant = await verifyGrantToken(cookie, hostArtifactId)
  if (grant === null) return artifactNotAvailable()

  const authorized = await authorizeArtifactRead(grant.artifactId, grant.viewerRef)
  if (authorized === null || authorized.versionId !== grant.versionId) {
    return artifactNotAvailable()
  }

  const requestedPath = (path ?? []).join('/')
  try {
    return requestedPath === ''
      ? await streamEntryDocument(authorized)
      : await redirectToAsset(authorized, requestedPath)
  } catch (error) {
    if (error instanceof HttpError && error.code === 'STORAGE_UNAVAILABLE') {
      return artifactStorageUnavailable()
    }
    throw error
  }
}
