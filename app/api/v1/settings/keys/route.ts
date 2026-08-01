import { z } from 'zod'

import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { PROVIDER_IDS } from '@/lib/providers'
import {
  deleteUserProviderKeys,
  getStoredProviderKey,
  storeUserProviderKey,
} from '@/lib/providers/user-keys'

/**
 * `POST` / `GET` / `DELETE /api/v1/settings/keys` (§5.3) — the user's own provider key.
 *
 * The key goes in sealed and never comes back out: `GET` answers with the provider, the last four
 * characters and when it was stored, and no other route reads it except the generation path,
 * which hands it straight to the provider SDK (§8, A.10.1.1).
 *
 * `enforceAuthRateLimit` because this is a credential surface: without it the endpoint is an
 * oracle for guessing which key an operator pasted.
 */

export const dynamic = 'force-dynamic'

const MIN_KEY_LENGTH = 8
const MAX_KEY_LENGTH = 500

const storeKeyBodySchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  apiKey: z.string().trim().min(MIN_KEY_LENGTH).max(MAX_KEY_LENGTH),
})

/**
 * The offending field names only — never the value, and never a length or a prefix, either of
 * which would leak part of a key into a response body and from there into a client log.
 */
function parseStoreKeyBody(body: unknown) {
  const parsed = storeKeyBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new HttpError('VALIDATION_FAILED', 'Provide a provider and an API key', {
      details: { fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') },
    })
  }
  return parsed.data
}

export async function POST(request: Request): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    enforceAuthRateLimit(request, 'settings-keys')
    requireJsonContentType(request)

    const body = parseStoreKeyBody(await readJsonBody(request))
    await storeUserProviderKey(sessionUser.id, body.provider, body.apiKey)

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function GET(): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    return jsonData(await getStoredProviderKey(sessionUser.id))
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Idempotent: 204 whether or not a key was stored, so a double-click cannot 404. */
export async function DELETE(): Promise<Response> {
  try {
    const sessionUser = await requireSessionUser()
    await deleteUserProviderKeys(sessionUser.id)

    return new Response(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
