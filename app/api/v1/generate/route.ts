import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
import { parsePrompt, startGeneration } from '@/lib/generation/run'
import { SSE_HEADERS } from '@/lib/generation/sse'
import { toErrorResponse } from '@/lib/http'
import { resolveProviderForUser } from '@/lib/providers'
import { loadUserProviderKeys } from '@/lib/providers/user-keys'
import { enforceQuota, recordGeneration } from '@/lib/quota'
import { clientIpFromHeaders } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * The stream is already open by the time this runs, so a failure here cannot become the response.
 * Logged and swallowed: the durable record of the attempt is the `generations` row, and turning a
 * counter write into a 500 would abandon a generation the user is already watching.
 */
async function countGeneration(userId: string): Promise<void> {
  try {
    await recordGeneration(userId)
  } catch (error) {
    console.error(JSON.stringify({ kind: 'quota.increment_failed', userId, error: String(error) }))
  }
}

/**
 * `POST /api/v1/generate` — the §5.4 event stream.
 *
 * Everything that can fail before the model says anything fails here, as a normal §5.3 error
 * response: no session, no JSON body, an empty prompt, no configured provider key. Once the body
 * is a stream the status line is spent, so later failures arrive as an `error` event instead.
 *
 * The §5.7 caps sit between key resolution and the provider call: which key runs decides which
 * daily quota applies, and a denied request must reach neither the provider nor `generations`.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    requireJsonContentType(request)
    const prompt = parsePrompt(await readJsonBody(request))

    const selection = resolveProviderForUser(await loadUserProviderKeys(sessionUser.id))
    await enforceQuota(sessionUser.id, !selection.usedInstanceKey)

    const stream = await startGeneration({
      userId: sessionUser.id,
      prompt,
      selection,
      signal: request.signal,
      actorIp: clientIpFromHeaders(request.headers),
    })

    // `startGeneration` resolves only once the provider has produced its first delta, so this
    // counts calls that actually reached the model — a rejected key consumes no daily quota.
    await countGeneration(sessionUser.id)

    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  } catch (error) {
    return toErrorResponse(error)
  }
}
