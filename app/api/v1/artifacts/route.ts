import { requireJsonContentType, readJsonBody } from '@/lib/api/guards'
import { requireApiPrincipal } from '@/lib/auth/bearer'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { listOwnedArtifacts } from '@/lib/artifacts/list'
import { parseListQuery } from '@/lib/artifacts/list-query'
import { parseCreateArtifactBody } from '@/lib/bundle/input'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * `POST /api/v1/artifacts` — creates the artifact and its first version (§5.3). Accepts a session
 * cookie or a bearer API token scoped `artifacts:write`; the artifact is owned by the token's user.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:write')
    requireJsonContentType(request)

    const parsed = parseCreateArtifactBody(await readJsonBody(request))
    if (!parsed.ok) {
      throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
        details: parsed.details,
      })
    }

    const created = await createArtifactWithBundle({
      ownerId: principal.userId,
      title: parsed.value.title,
      visibility: parsed.value.visibility,
      files: parsed.value.files,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(created, 201)
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** `GET /api/v1/artifacts` — the caller's own artifacts. Owner-only until S4. */
export async function GET(request: Request): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:read')

    const query = parseListQuery(new URL(request.url).searchParams)
    if (!query.ok) {
      throw new HttpError('VALIDATION_FAILED', 'The query parameters are not valid', {
        details: query.details,
      })
    }

    return jsonData(await listOwnedArtifacts(principal.userId, query.value))
  } catch (error) {
    return toErrorResponse(error)
  }
}
