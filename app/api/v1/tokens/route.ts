import { z } from 'zod'

import { API_TOKEN_SCOPES } from '@/db/schema/api-tokens'
import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
import { createApiToken, listApiTokens } from '@/lib/auth/bearer'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

/**
 * `POST /api/v1/tokens` and `GET /api/v1/tokens` (§5.3). Session-only on purpose: a token cannot
 * mint another token, so a leaked token cannot be used to outlive its own revocation.
 */

export const dynamic = 'force-dynamic'

const MAX_TOKEN_NAME_LENGTH = 100

const createTokenBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_TOKEN_NAME_LENGTH),
  scopes: z.array(z.enum(API_TOKEN_SCOPES)).min(1),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
})

function parseCreateTokenBody(body: unknown) {
  const parsed = createTokenBodySchema.safeParse(body)
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

export async function POST(request: Request): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    requireJsonContentType(request)

    const body = parseCreateTokenBody(await readJsonBody(request))
    const created = await createApiToken({
      userId: sessionUser.id,
      name: body.name,
      // Deduplicated so a repeated scope cannot pad the stored array.
      scopes: [...new Set(body.scopes)],
      expiresAt: body.expiresAt === undefined ? null : new Date(body.expiresAt),
      actorIp: clientIpFromHeaders(request.headers),
    })

    // The only response that ever carries `token`. There is no second read of it anywhere.
    return jsonData(
      {
        id: created.id,
        token: created.plaintext,
        name: created.name,
        scopes: created.scopes,
        expiresAt: created.expiresAt,
      },
      201,
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function GET(): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    return jsonData({ items: await listApiTokens(sessionUser.id) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
