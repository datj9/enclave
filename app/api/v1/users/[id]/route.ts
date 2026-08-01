import { z } from 'zod'

import { requireAdminUser } from '@/lib/admin/guards'
import { deleteUser, setUserAccess } from '@/lib/admin/users'
import { readJsonBody, requireJsonContentType } from '@/lib/api/guards'
import { USER_ROLES } from '@/db/schema/users'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

/**
 * `PATCH /api/v1/users/{id}` and `DELETE /api/v1/users/{id}` (§5.3), admin-only.
 *
 * PATCH is the reversible control: deactivating 401s the account's next request and kills its
 * sessions, while the org-visible artifacts it owns stay visible to everyone else. DELETE refuses
 * with 409 while the account still owns artifacts — never a cascade.
 */

export const dynamic = 'force-dynamic'

const userIdSchema = z.uuid()

const patchUserBodySchema = z.object({
  isActive: z.boolean(),
  role: z.enum(USER_ROLES).optional(),
})

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

async function requireUserId(context: RouteContext): Promise<string> {
  const { id } = await context.params
  if (!userIdSchema.safeParse(id).success) throw new HttpError('NOT_FOUND', 'No such user')
  return id
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const admin = await requireAdminUser()
    requireJsonContentType(request)
    const userId = await requireUserId(context)

    const parsed = patchUserBodySchema.safeParse(await readJsonBody(request))
    if (!parsed.success) {
      throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
        details: { fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') },
      })
    }

    const updated = await setUserAccess({
      actorId: admin.id,
      userId,
      isActive: parsed.data.isActive,
      ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(updated)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const admin = await requireAdminUser()
    await deleteUser({ actorId: admin.id, userId: await requireUserId(context) })

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
