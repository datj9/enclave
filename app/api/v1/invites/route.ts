import { z } from 'zod'

import { requireAdminUser } from '@/lib/admin/guards'
import { readJsonBody, requireJsonContentType } from '@/lib/api/guards'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import {
  DEFAULT_INVITE_TTL_HOURS,
  MAX_INVITE_TTL_HOURS,
  createInvite,
  listInvites,
} from '@/lib/invites/manage'
import { clientIpFromHeaders } from '@/lib/rate-limit'

/**
 * `POST /api/v1/invites` and `GET /api/v1/invites` (§5.3), admin-only. The POST response is the
 * only place an invite token is ever readable — the same show-once contract as `/api/v1/tokens`.
 * The GET list never carries one, and neither does the audit row.
 */

export const dynamic = 'force-dynamic'

const createInviteBodySchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
  expiresInHours: z.number().int().min(1).max(MAX_INVITE_TTL_HOURS).default(DEFAULT_INVITE_TTL_HOURS),
})

function parseCreateInviteBody(body: unknown) {
  const parsed = createInviteBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
      details: { fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') },
    })
  }
  return parsed.data
}

export async function POST(request: Request): Promise<Response> {
  try {
    const admin = await requireAdminUser()
    requireJsonContentType(request)

    const body = parseCreateInviteBody(await readJsonBody(request))
    const created = await createInvite({
      createdBy: admin.id,
      email: body.email ?? null,
      expiresInHours: body.expiresInHours,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(created, 201)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function GET(): Promise<Response> {
  try {
    await requireAdminUser()
    return jsonData({ items: await listInvites() })
  } catch (error) {
    return toErrorResponse(error)
  }
}
