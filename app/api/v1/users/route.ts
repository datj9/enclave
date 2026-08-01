import { requireAdminUser } from '@/lib/admin/guards'
import { listUsers } from '@/lib/admin/users'
import { jsonData, toErrorResponse } from '@/lib/http'

/**
 * `GET /api/v1/users` — the admin roster. Ids, addresses, roles, and artifact *counts*; no titles
 * and no artifact content of any kind (§5.1 branch 5, decision #26).
 */

export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  try {
    await requireAdminUser()
    return jsonData({ items: await listUsers() })
  } catch (error) {
    return toErrorResponse(error)
  }
}
