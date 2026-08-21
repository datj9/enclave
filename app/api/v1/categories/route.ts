import { requireAdminUser } from '@/lib/admin/guards'
import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
import { createCategory, listCategories } from '@/lib/categories/manage'
import { parseCategoryBody } from '@/lib/categories/input'
import { jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    const includeInactive = new URL(request.url).searchParams.get('includeInactive') === 'true'
    if (includeInactive) await requireAdminUser()

    return jsonData({ items: await listCategories({ includeInactive }) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const admin = await requireAdminUser()
    requireJsonContentType(request)

    const body = parseCategoryBody(await readJsonBody(request))
    const created = await createCategory({
      name: body.name,
      description: body.description,
      createdBy: admin.id,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(created, 201)
  } catch (error) {
    return toErrorResponse(error)
  }
}
