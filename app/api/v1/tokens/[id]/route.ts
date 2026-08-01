import { requireSessionUser } from '@/lib/api/guards'
import { revokeApiToken } from '@/lib/auth/bearer'
import { HttpError, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

/** `DELETE /api/v1/tokens/{id}` → 204 (§5.3). Revocation takes effect on the next request. */

export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    const { id } = await context.params

    // 404 rather than 403 for someone else's token id, so the response cannot confirm it exists.
    if (!UUID_PATTERN.test(id)) throw new HttpError('NOT_FOUND', 'No such token')

    const revoked = await revokeApiToken(sessionUser.id, id, clientIpFromHeaders(request.headers))
    if (!revoked) throw new HttpError('NOT_FOUND', 'No such token')

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
