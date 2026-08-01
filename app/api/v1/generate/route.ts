import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
import { parsePrompt, startGeneration } from '@/lib/generation/run'
import { SSE_HEADERS } from '@/lib/generation/sse'
import { toErrorResponse } from '@/lib/http'
import { resolveProviderForUser } from '@/lib/providers'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * `POST /api/v1/generate` — the §5.4 event stream.
 *
 * Everything that can fail before the model says anything fails here, as a normal §5.3 error
 * response: no session, no JSON body, an empty prompt, no configured provider key. Once the body
 * is a stream the status line is spent, so later failures arrive as an `error` event instead.
 *
 * Rate limits and the daily quota are S7 and are deliberately absent.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    requireJsonContentType(request)
    const prompt = parsePrompt(await readJsonBody(request))

    const stream = await startGeneration({
      userId: sessionUser.id,
      prompt,
      selection: resolveProviderForUser(),
      signal: request.signal,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  } catch (error) {
    return toErrorResponse(error)
  }
}
