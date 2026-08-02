import { requireApiPrincipal } from '@/lib/auth/bearer'
import { parseListQuery } from '@/lib/artifacts/list-query'
import { listTrashedArtifacts } from '@/lib/artifacts/trash'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/v1/artifacts/trash` — the caller's own trash (S21), so a CLI can reach what `/trash`
 * renders. Owner-scoped in SQL rather than through `canRead`, which refuses a deleted artifact to
 * everyone including its owner.
 *
 * The static `trash` segment outranks the sibling `[id]` route, so this never lands in the
 * single-artifact handler with `"trash"` as an id.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:read')

    const query = parseListQuery(new URL(request.url).searchParams)
    if (!query.ok) {
      throw new HttpError('VALIDATION_FAILED', 'The query parameters are not valid', {
        details: query.details,
      })
    }

    const page = await listTrashedArtifacts(principal.userId, query.value)

    return jsonData({
      items: page.items.map((item) => ({
        id: item.id,
        title: item.title,
        visibility: item.visibility,
        deletedAt: item.deletedAt,
        // The lib's word for it is `daysRemaining`; the S21 wire contract names it this.
        daysUntilPurge: item.daysRemaining,
      })),
      nextCursor: page.nextCursor,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
