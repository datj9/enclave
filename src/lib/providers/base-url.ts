/**
 * Validates a user-supplied base URL for `anthropic-compatible` / `openai-compatible`
 * credentials. http/https only — anything else is either a footgun (`file:`, `data:`) or not a
 * network endpoint at all.
 */

export const MAX_BASE_URL_LENGTH = 2048

export function normaliseBaseUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_BASE_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  if (url.username !== '' || url.password !== '') return null

  const pathname =
    url.pathname === '/'
      ? ''
      : url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname
  return `${url.origin}${pathname}${url.search}${url.hash}`
}
