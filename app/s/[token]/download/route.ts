import type { NextRequest } from 'next/server'

import { authorizeArtifactRead, shareViewerRef } from '@/lib/artifacts/authorize'
import { buildDownload } from '@/lib/artifacts/export/build-download'
import { slugFromTitle } from '@/lib/artifacts/naming'
import { readArtifactTitle } from '@/lib/artifacts/page-read'
import { jsonError, toErrorResponse } from '@/lib/http'
import { resolveShareLinkByToken } from '@/lib/shares/links'
import { objectStore } from '@/lib/storage/s3'

/**
 * The share-link download route: `/s/{token}/download?format=md|html`.
 *
 * Same fixed order as `/a/{id}/download` — format validation before anything else — with the
 * token standing in for a session. The token *is* the capability: no sign-in here, an unknown,
 * revoked, expired or purged link is one indistinguishable 404, and the version served is the
 * one the link pins (`authorizeArtifactRead` handles that when it resolves the `share:` ref).
 */
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  try {
    const format = new URL(request.url).searchParams.get('format')
    if (format !== 'md' && format !== 'html') {
      return jsonError('VALIDATION_FAILED', 'unsupported format', { status: 400 })
    }

    const { token } = await params
    const resolved = await resolveShareLinkByToken(decodeURIComponent(token))
    if (resolved === null) {
      return jsonError('NOT_FOUND', 'not found')
    }

    const authorized = await authorizeArtifactRead(
      resolved.link.artifactId,
      shareViewerRef(resolved.shareLinkId),
    )
    if (authorized === null) {
      return jsonError('NOT_FOUND', 'not found')
    }

    // No audit row: `AUDIT_ACTIONS` has no `artifact.download` action, and adding one is out of
    // scope. The ids and format are not PII, so an info line is all the trail this needs.
    console.info(authorized.artifactId, authorized.versionId, format)

    const { body, contentType } = await buildDownload(authorized, format, objectStore())
    const title = (await readArtifactTitle(authorized.artifactId)) ?? 'artifact'
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-disposition': `attachment; filename="${slugFromTitle(title)}.${format}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}