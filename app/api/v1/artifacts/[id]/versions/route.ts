import { requireJsonContentType, readJsonBody } from '@/lib/api/guards'
import { requireApiPrincipal } from '@/lib/auth/bearer'
import { appendVersion } from '@/lib/artifacts/versions'
import { parseAppendVersionBody } from '@/lib/bundle/input'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

/**
 * `POST /api/v1/artifacts/{id}/versions` — appends version N+1 at the artifact's `viewUrl`
 * (§5.3). Artifact properties do not move here; `title` and `visibility` belong to PATCH.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:write')
    requireJsonContentType(request)
    const { id } = await context.params

    const parsed = parseAppendVersionBody(await readJsonBody(request))
    if (!parsed.ok) {
      throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
        details: parsed.details,
      })
    }

    const appended = await appendVersion({
      artifactId: id,
      ownerId: principal.userId,
      files: parsed.value.files,
      ...(parsed.value.expectedVersionNo === undefined
        ? {}
        : { expectedVersionNo: parsed.value.expectedVersionNo }),
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(appended, 201)
  } catch (error) {
    return toErrorResponse(error)
  }
}