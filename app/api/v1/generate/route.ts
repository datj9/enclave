import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
import { parsePrompt, startGeneration } from '@/lib/generation/run'
import { SSE_HEADERS } from '@/lib/generation/sse'
import { toErrorResponse } from '@/lib/http'
import { resolveProviderForUser } from '@/lib/providers'
import { loadUserProviderKeys } from '@/lib/providers/user-keys'
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
 * The §5.7 caps sit between key resolution and the provider call: which key runs decides which
 * caps apply, and a denied request must reach neither the provider nor `generations`.
 * `startGeneration` checks and spends them in one locked step (src/lib/quota.ts), so concurrent
 * requests cannot overshoot, and refunds the daily unit when the provider rejects the call.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    requireJsonContentType(request)
    const prompt = parsePrompt(await readJsonBody(request))

    const selection = resolveProviderForUser(await loadUserProviderKeys(sessionUser.id))

    const stream = await startGeneration({
      userId: sessionUser.id,
      prompt,
      selection,
      signal: request.signal,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  } catch (error) {
    return toErrorResponse(error)
  }
}
