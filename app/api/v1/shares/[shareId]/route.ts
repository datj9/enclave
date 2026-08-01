import { apiTokenViewerRef, userViewerRef } from '@/lib/artifacts/authorize'
import { requireApiPrincipal, type ApiPrincipal } from '@/lib/auth/bearer'
import { toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { revokeShareLink } from '@/lib/shares/manage'

/**
 * `DELETE /api/v1/shares/{shareId}` (§5.3). Revocation is a single `revoked_at` write, and the
 * next document load re-reads the row through `canRead` branch 4 — which is what makes the 404
 * immediate rather than waiting on the grant cookie's 30 minutes.
 */

export const dynamic = 'force-dynamic'

interface RouteContext {
  readonly params: Promise<{ readonly shareId: string }>
}

function viewerRefOf(principal: ApiPrincipal): string {
  return principal.kind === 'apiToken'
    ? apiTokenViewerRef(principal.userId)
    : userViewerRef(principal.userId)
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'shares:write')
    const { shareId } = await context.params

    await revokeShareLink(
      shareId,
      viewerRefOf(principal),
      clientIpFromHeaders(request.headers),
    )

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
