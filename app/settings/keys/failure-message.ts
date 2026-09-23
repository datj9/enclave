/**
 * What to tell the user when a provider-key request fails.
 *
 * The API answers failures with the HttpError envelope, `{ error: { code, message } }`, and for
 * this route the message is often the whole point — a base URL refused because it targets a
 * loopback, link-local, metadata or (when the operator blocks it) private address comes back as a
 * 422 naming exactly that. Showing it beats a generic "check it and try again", which gives the
 * user nothing to check.
 *
 * Tolerant by design: a body that is not JSON, not an envelope, or carries an empty message falls
 * back to the caller's generic text rather than rendering `undefined` or a stack of JSON.
 */

/** Longer than any message this API writes; a longer one is not a sentence meant for a person. */
const MAX_MESSAGE_LENGTH = 300

export function envelopeMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const error = (body as { readonly error?: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const message = (error as { readonly message?: unknown }).message
  if (typeof message !== 'string') return null
  const trimmed = message.trim()
  if (trimmed === '' || trimmed.length > MAX_MESSAGE_LENGTH) return null
  return trimmed
}

/** Reads a failed response's envelope message, or returns `fallback`. Never throws. */
export async function failureMessage(response: Response, fallback: string): Promise<string> {
  try {
    return envelopeMessage(await response.json()) ?? fallback
  } catch {
    return fallback
  }
}
