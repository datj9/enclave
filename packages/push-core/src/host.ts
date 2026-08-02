const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
const CONTROL_CHARACTERS = /[\x00-\x1f]/
const DEFAULT_PORT: Readonly<Record<'http' | 'https', string>> = { http: '80', https: '443' }

export class InvalidHostError extends Error {}

/**
 * An explicit scheme always wins over the loopback heuristic — inventing https for a host the
 * user asked for over http is the bug this function exists to fix. `isInsecureAllowed` gates the
 * one case that heuristic can't cover safely: an explicit http origin that isn't loopback, where
 * defaulting to "allow" would send a bearer token in cleartext to whatever host is in a committed
 * `.enclave.json`.
 */
export function normaliseHost(raw: string, isInsecureAllowed = false): string {
  const trimmed = raw.trim()
  if (trimmed === '') throw new InvalidHostError('no host was given')
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new InvalidHostError(`'${raw}' contains control characters`)
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
    throw new InvalidHostError(`only http and https are supported, got '${raw}'`)
  }

  let parsed: URL
  try {
    parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`)
  } catch {
    throw new InvalidHostError(`'${raw}' is not a valid host`)
  }
  if (parsed.hostname === '') throw new InvalidHostError(`'${raw}' is not a valid host`)
  if (parsed.username !== '' || parsed.password !== '') {
    throw new InvalidHostError('a host must not carry credentials')
  }
  if (parsed.pathname !== '/') {
    throw new InvalidHostError(
      `'${raw}' has a path ('${parsed.pathname}') — only scheme://host[:port] is accepted`,
    )
  }

  const hostname = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname
  const isLoopback = LOOPBACK_HOSTNAMES.has(hostname)
  const scheme = hasScheme
    ? (parsed.protocol.slice(0, -1) as 'http' | 'https')
    : isLoopback
      ? 'http'
      : 'https'

  if (scheme === 'http' && !isLoopback && !isInsecureAllowed) {
    throw new InvalidHostError(
      `refusing to send credentials over http to '${hostname}' — pass --insecure to override`,
    )
  }

  const port = parsed.port === DEFAULT_PORT[scheme] ? '' : parsed.port
  return `${scheme}://${hostname}${port === '' ? '' : `:${port}`}`
}
