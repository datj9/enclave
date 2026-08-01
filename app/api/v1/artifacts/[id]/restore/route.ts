import { apiTokenViewerRef, userViewerRef } from '@/lib/artifacts/authorize'
import { restoreArtifact } from '@/lib/artifacts/update'
import { requireApiPrincipal, type ApiPrincipal } from '@/lib/auth/bearer'
import { jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

/**
 * `POST /api/v1/artifacts/{id}/restore` (§5.3). Owner-only, and every refusal is the same 404 —
 * a trashed artifact must not be discoverable by anyone, so there is no 403 to be earned here.
 */

export const dynamic = 'force-dynamic'

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

function viewerRefOf(principal: ApiPrincipal): string {
  return principal.kind === 'apiToken'
    ? apiTokenViewerRef(principal.userId)
    : userViewerRef(principal.userId)
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:write')
    const { id } = await context.params

    const artifact = await restoreArtifact({
      artifactId: id,
      viewerRef: viewerRefOf(principal),
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(artifact)
  } catch (error) {
    return toErrorResponse(error)
  }
}
