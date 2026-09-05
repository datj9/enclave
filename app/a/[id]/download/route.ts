import type { NextRequest } from 'next/server'

import {
  ANONYMOUS_VIEWER_REF,
  authorizeArtifactRead,
  userViewerRef,
} from '@/lib/artifacts/authorize'
import { buildDownload } from '@/lib/artifacts/export/build-download'
import { slugFromTitle } from '@/lib/artifacts/naming'
import { readArtifactTitle } from '@/lib/artifacts/page-read'
import { getSessionUser } from '@/lib/auth/session'
import { jsonError, toErrorResponse } from '@/lib/http'
import { objectStore } from '@/lib/storage/s3'

/**
 * The session/anonymous download route: `/a/{id}/download?format=md|html`.
 *
 * Order is fixed: validate the format first, authorise second, build last. Validating before
 * auth means `?format=zip` answers the same 400 whether or not the artifact is readable, so the
 * error never leaks a readability oracle (same reasoning as `page-read.ts`'s signin/missing
 * split, but for a route that must not redirect — a redirect would break the PDF print flow).
 *
 * The 404 here is byte-identical for signed-out and signed-in viewers: no sign-in redirect, no
 * "this artifact is private" hint. `toErrorResponse` maps the rest (413/422/500) from the throws
 * `buildDownload` makes.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const format = new URL(request.url).searchParams.get('format')
    if (format !== 'md' && format !== 'html') {
      return jsonError('VALIDATION_FAILED', 'unsupported format', { status: 400 })
    }

    // Mirrors `authorizeAsViewer` in page-read.ts: a signed-in viewer's ref first (that is who
    // they are in the audit trail), the anonymous ref only as the fallback for a public artifact.
    const { id } = await params
    const user = await getSessionUser()
    const viewerRef = user === null ? ANONYMOUS_VIEWER_REF : userViewerRef(user.id)
    const authorized =
      (await authorizeArtifactRead(id, viewerRef)) ??
      (viewerRef === ANONYMOUS_VIEWER_REF
        ? null
        : await authorizeArtifactRead(id, ANONYMOUS_VIEWER_REF))

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
        // The slug is ASCII, so a plain filename= is enough; no filename* needed.
        'content-disposition': `attachment; filename="${slugFromTitle(title)}.${format}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}