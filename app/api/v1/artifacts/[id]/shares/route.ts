import { z } from 'zod'

import { readJsonBody, requireJsonContentType } from '@/lib/api/guards'
import { apiTokenViewerRef, userViewerRef } from '@/lib/artifacts/authorize'
import { requireApiPrincipal, type ApiPrincipal } from '@/lib/auth/bearer'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { createShareLink, listShareLinks } from '@/lib/shares/manage'

/**
 * `POST /api/v1/artifacts/{id}/shares` and `GET …/shares` (§5.3), both owner-only.
 *
 * The `shares:write` scope gates both: creating a link is the act the scope exists for, and the
 * list is the same capability read back. Neither response body may carry a token except the one
 * marked below (§8).
 */

export const dynamic = 'force-dynamic'

const createShareBodySchema = z
  .object({
    versionId: z.uuid().optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  // Refused rather than ignored: a misspelled `expiresAt` must not silently create a link that
  // never expires.
  .strict()

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

function viewerRefOf(principal: ApiPrincipal): string {
  return principal.kind === 'apiToken'
    ? apiTokenViewerRef(principal.userId)
    : userViewerRef(principal.userId)
}

function parseCreateShareBody(body: unknown) {
  const parsed = createShareBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
      details: {
        fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
        issues: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      },
    })
  }
  return parsed.data
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'shares:write')
    requireJsonContentType(request)
    const { id } = await context.params

    const body = parseCreateShareBody(await readJsonBody(request))
    const created = await createShareLink({
      artifactId: id,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      viewerRef: viewerRefOf(principal),
      expiresAt: body.expiresAt === undefined ? null : new Date(body.expiresAt),
      actorIp: clientIpFromHeaders(request.headers),
    })

    // The only response that ever carries `token`. There is no second read of it anywhere.
    return jsonData(created, 201)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'shares:write')
    const { id } = await context.params

    return jsonData(await listShareLinks(id, viewerRefOf(principal)))
  } catch (error) {
    return toErrorResponse(error)
  }
}
