import { readJsonBody, requireJsonContentType } from '@/lib/api/guards'
import { apiTokenViewerRef, userViewerRef } from '@/lib/artifacts/authorize'
import {
  assertCategoriesAvailable,
  readArtifactTags,
  replaceArtifactTags,
} from '@/lib/artifacts/tags'
import {
  parseUpdateArtifactBody,
  readArtifactView,
  softDeleteArtifact,
  updateArtifact,
} from '@/lib/artifacts/update'
import { requireApiPrincipal, type ApiPrincipal } from '@/lib/auth/bearer'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'

/**
 * The single artifact resource (§5.3). Every method runs the same gate: `canRead` first, so an
 * unreadable artifact is a 404 that cannot be told apart from a nonexistent one, and only then
 * the owner check that produces a 403.
 */

export const dynamic = 'force-dynamic'

interface RouteContext {
  readonly params: Promise<{ readonly id: string }>
}

function viewerRefOf(principal: ApiPrincipal): string {
  return principal.kind === 'apiToken'
    ? apiTokenViewerRef(principal.userId)
    : userViewerRef(principal.userId)
}

/** The tests invoke the PATCH handler with only a Request; fall back to the URL's last segment. */
function artifactIdOf(request: Request, context: RouteContext | undefined): Promise<string> {
  if (context !== undefined) return context.params.then(({ id }) => id)
  const segment = new URL(request.url).pathname.split('/').filter(Boolean).pop()
  if (segment === undefined) throw new HttpError('NOT_FOUND', 'No such artifact')
  return Promise.resolve(segment)
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:read')
    const { id } = await context.params

    const artifact = await readArtifactView(id, viewerRefOf(principal))
    if (artifact === null) throw new HttpError('NOT_FOUND', 'No such artifact')

    return jsonData(artifact)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: Request, context: RouteContext | undefined): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:write')
    requireJsonContentType(request)
    const id = await artifactIdOf(request, context)

    const parsed = parseUpdateArtifactBody(await readJsonBody(request))
    if (!parsed.ok) {
      throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
        details: parsed.details,
      })
    }

    // Validate category ids before any write so a PATCH mixing `title` and bad `categoryIds`
    // cannot commit the rename and then fail the tag half with a 422.
    if (parsed.value.categoryIds !== undefined) {
      await assertCategoriesAvailable(parsed.value.categoryIds)
    }

    const artifact = await updateArtifact({
      artifactId: id,
      viewerRef: viewerRefOf(principal),
      patch: parsed.value,
      actorIp: clientIpFromHeaders(request.headers),
    })

    let categories: readonly { readonly slug: string }[] = []
    if (parsed.value.categoryIds !== undefined) {
      const tagged = await replaceArtifactTags({
        artifactId: id,
        categoryIds: parsed.value.categoryIds,
        viewerRef: viewerRefOf(principal),
        actorIp: clientIpFromHeaders(request.headers),
      })
      categories = tagged.map((category) => ({ slug: category.slug }))
    } else {
      categories = (await readArtifactTags([id])).get(id) ?? []
    }

    return jsonData({ ...artifact, categories })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const principal = await requireApiPrincipal(request, 'artifacts:write')
    const { id } = await context.params

    await softDeleteArtifact({
      artifactId: id,
      viewerRef: viewerRefOf(principal),
      actorIp: clientIpFromHeaders(request.headers),
    })

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
