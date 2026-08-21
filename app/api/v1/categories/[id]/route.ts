import { requireAdminUser } from '@/lib/admin/guards'
import { readJsonBody, requireJsonContentType } from '@/lib/api/guards'
import { parseCategoryPatchBody } from '@/lib/categories/input'
import { updateCategory } from '@/lib/categories/manage'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

function categoryIdOf(request: Request, context: RouteContext | undefined): Promise<string> {
  if (context !== undefined) return context.params.then((params) => params.id)
  const segments = new URL(request.url).pathname.split('/').filter((segment) => segment !== '')
  const id = segments.at(-1)
  if (id === undefined) throw new HttpError('NOT_FOUND', 'That category does not exist')
  return Promise.resolve(id)
}

export async function PATCH(request: Request, context?: RouteContext): Promise<Response> {
  try {
    const admin = await requireAdminUser()
    requireJsonContentType(request)

    const id = await categoryIdOf(request, context)
    const body = parseCategoryPatchBody(await readJsonBody(request))
    const updated = await updateCategory({
      categoryId: id,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      actorId: admin.id,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return jsonData(updated)
  } catch (error) {
    return toErrorResponse(error)
  }
}
