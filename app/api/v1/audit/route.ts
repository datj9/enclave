import { requireAdminUser } from '@/lib/admin/guards'
import { parseAuditFilter } from '@/lib/admin/audit-query'
import { readAuditPage } from '@/lib/admin/audit-read'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'

/**
 * `GET /api/v1/audit` (§5.3, A.12.4.1) — admin-only. Filters by action, actor, artifact, and date
 * range, and returns ids plus metadata only: no query behind this route touches `artifacts`,
 * `artifact_versions`, or object storage, so an artifact's title and bytes cannot appear here.
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdminUser()

    const parsed = parseAuditFilter(new URL(request.url).searchParams)
    if (!parsed.ok) {
      throw new HttpError('VALIDATION_FAILED', 'The query is not valid', { details: parsed.details })
    }

    return jsonData(await readAuditPage(parsed.value))
  } catch (error) {
    return toErrorResponse(error)
  }
}
