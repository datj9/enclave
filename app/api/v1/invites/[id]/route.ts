import { z } from 'zod'

import { requireAdminUser } from '@/lib/admin/guards'
import { HttpError, toErrorResponse } from '@/lib/http'
import { revokeInvite } from '@/lib/invites/manage'

/**
 * `DELETE /api/v1/invites/{id}` — revoke an outstanding invite. Admin-only, and a no-op on an
 * invite that was already redeemed: `used_at` is what the gate reads, and rewriting the row to
 * say "revoked" would misreport who redeemed it.
 */

export const dynamic = 'force-dynamic'

const inviteIdSchema = z.uuid()

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireAdminUser()

    const { id } = await context.params
    if (!inviteIdSchema.safeParse(id).success) throw new HttpError('NOT_FOUND', 'No such invite')
    if (!(await revokeInvite(id))) throw new HttpError('NOT_FOUND', 'No such invite')

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
