import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_BASE_URL_LENGTH,
  checkBaseUrlTarget,
  classifyAddress,
  normaliseBaseUrl,
  warnIfUnsafeStoredBaseUrl,
  type ResolveHost,
} from '@/lib/providers/base-url'
import { acceptsBaseUrl } from '@/lib/providers/types'

/**
 * Spec — editable provider + `anthropic-compatible` + per-key base URL, §`src/lib/providers/base-url.ts`.
 * `normaliseBaseUrl` is the one gate between whatever a user pastes into settings and a value that
 * ever reaches an outbound HTTP client, so every rejection case below is a worked example from
 * the spec, not a guess.
 */

describe('normaliseBaseUrl', () => {
  it('trims whitespace and strips a single trailing slash from the pathname', () => {
    expect(normaliseBaseUrl('  https://gw.example.com/v1/  ')).toBe('https://gw.example.com/v1')
  })

  // Syntax only: whether a loopback target may be *used* is checkBaseUrlTarget's call (below),
  // which refuses it for user-stored keys.
  it('normalises a loopback address without judging the target', () => {
    expect(normaliseBaseUrl('http://localhost:11434')).toBe('http://localhost:11434')
  })

  it('rejects the file scheme', () => {
    expect(normaliseBaseUrl('file:///etc/passwd')).toBeNull()
  })

  it('rejects a relative URL with no scheme or host', () => {
    expect(normaliseBaseUrl('gw.example.com')).toBeNull()
  })

  it('rejects a URL carrying embedded credentials', () => {
    expect(normaliseBaseUrl('https://user:pw@gw.example.com')).toBeNull()
  })

  it('rejects the data scheme', () => {
    expect(normaliseBaseUrl('data:text/plain,hello')).toBeNull()
  })

  it('rejects the javascript scheme', () => {
    expect(normaliseBaseUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects the ftp scheme', () => {
    expect(normaliseBaseUrl('ftp://gw.example.com')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(normaliseBaseUrl('')).toBeNull()
  })

  it('rejects a URL over the maximum length', () => {
    const overLong = `https://gw.example.com/${'a'.repeat(MAX_BASE_URL_LENGTH)}`
    expect(normaliseBaseUrl(overLong)).toBeNull()
  })

  it('leaves a root path with no trailing slash unchanged', () => {
    expect(normaliseBaseUrl('https://gw.example.com')).toBe('https://gw.example.com')
  })

  it('preserves a query string and hash while stripping the trailing slash', () => {
    expect(normaliseBaseUrl('https://gw.example.com/v1/?key=1#frag')).toBe(
      'https://gw.example.com/v1?key=1#frag',
    )
  })
})

describe('acceptsBaseUrl', () => {
  it('accepts anthropic-compatible', () => {
    expect(acceptsBaseUrl('anthropic-compatible')).toBe(true)
  })

  it('accepts openai-compatible', () => {
    expect(acceptsBaseUrl('openai-compatible')).toBe(true)
  })

  it('rejects plain anthropic', () => {
    expect(acceptsBaseUrl('anthropic')).toBe(false)
  })
})

/** A resolver that answers from a fixed table and fails for anything else, like ENOTFOUND. */
function fakeResolver(table: Record<string, readonly string[]>): ResolveHost {
  return (hostname) => {
    const addresses = table[hostname]
    if (addresses === undefined) return Promise.reject(new Error(`ENOTFOUND ${hostname}`))
    return Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    )
  }
}

const SOFT = { blockPrivate: false, resolve: fakeResolver({}) } as const
const STRICT = { blockPrivate: true, resolve: fakeResolver({}) } as const

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.10.20.30', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['169.254.1.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['100.100.100.200', 'link-local'],
    ['fd00:ec2::254', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'unspecified'],
  ])('always refuses %s (%s), even with private ranges allowed', (address, kind) => {
    const verdict = classifyAddress(address, false)

    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason.toLowerCase()).toContain(kind.split('-')[0])
  })

  it.each([
    '10.0.0.5',
    '172.16.4.2',
    '172.31.255.255',
    '192.168.1.20',
    '100.64.0.1',
    'fd12:3456::1',
  ])('allows the private address %s by default, for a LAN model server', (address) => {
    expect(classifyAddress(address, false)).toEqual({ allowed: true })
  })

  it.each([
    '10.0.0.5',
    '172.16.4.2',
    '192.168.1.20',
    '100.64.0.1',
    'fd12:3456::1',
    '::ffff:10.0.0.5',
  ])('refuses the private address %s when the operator blocks private ranges', (address) => {
    expect(classifyAddress(address, true)).toMatchObject({ allowed: false })
  })

  it.each(['203.0.113.7', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])(
    'allows the public address %s under either policy',
    (address) => {
      expect(classifyAddress(address, true)).toEqual({ allowed: true })
    },
  )
})

describe('checkBaseUrlTarget', () => {
  it('refuses localhost and its subdomains without asking DNS', async () => {
    const resolve = vi.fn<ResolveHost>()

    await expect(
      checkBaseUrlTarget('http://localhost:11434', { blockPrivate: false, resolve }),
    ).resolves.toMatchObject({ allowed: false })
    await expect(
      checkBaseUrlTarget('http://api.localhost.', { blockPrivate: false, resolve }),
    ).resolves.toMatchObject({ allowed: false })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses a cloud metadata hostname', async () => {
    await expect(
      checkBaseUrlTarget('http://metadata.google.internal/computeMetadata/v1', SOFT),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('refuses an IP literal in any spelling the URL parser normalises', async () => {
    await expect(checkBaseUrlTarget('http://2130706433:8080', SOFT)).resolves.toMatchObject({
      allowed: false,
    })
    await expect(checkBaseUrlTarget('http://0x7f.1/v1', SOFT)).resolves.toMatchObject({
      allowed: false,
    })
    await expect(checkBaseUrlTarget('http://[::1]:11434', SOFT)).resolves.toMatchObject({
      allowed: false,
    })
    await expect(
      checkBaseUrlTarget('http://[::ffff:169.254.169.254]/latest', SOFT),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('allows a LAN Ollama by IP under the default policy', async () => {
    await expect(checkBaseUrlTarget('http://192.168.1.50:11434/v1', SOFT)).resolves.toEqual({
      allowed: true,
    })
  })

  it('refuses a hostname that resolves inward', async () => {
    const resolve = fakeResolver({ 'evil.example': ['127.0.0.1'] })

    await expect(
      checkBaseUrlTarget('https://evil.example/v1', { blockPrivate: false, resolve }),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('refuses when any one of several resolved addresses is refused', async () => {
    const resolve = fakeResolver({ 'mixed.example': ['203.0.113.7', '169.254.169.254'] })

    await expect(
      checkBaseUrlTarget('https://mixed.example', { blockPrivate: false, resolve }),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('allows a hostname resolving to a private address unless private ranges are blocked', async () => {
    const resolve = fakeResolver({ ollama: ['172.18.0.4'] })

    await expect(
      checkBaseUrlTarget('http://ollama:11434/v1', { blockPrivate: false, resolve }),
    ).resolves.toEqual({ allowed: true })
    await expect(
      checkBaseUrlTarget('http://ollama:11434/v1', { blockPrivate: true, resolve }),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('allows a hostname resolving to public addresses', async () => {
    const resolve = fakeResolver({ 'gw.example.com': ['203.0.113.7', '2001:db8::1'] })

    await expect(
      checkBaseUrlTarget('https://gw.example.com/v1', { blockPrivate: true, resolve }),
    ).resolves.toEqual({ allowed: true })
  })

  it('allows a hostname that does not resolve here, rather than guessing', async () => {
    await expect(checkBaseUrlTarget('http://only-in-prod.internal', STRICT)).resolves.toEqual({
      allowed: true,
    })
  })

  it('does not require https', async () => {
    const resolve = fakeResolver({ 'gw.example.com': ['203.0.113.7'] })

    await expect(
      checkBaseUrlTarget('http://gw.example.com', { blockPrivate: true, resolve }),
    ).resolves.toEqual({ allowed: true })
  })
})

describe('warnIfUnsafeStoredBaseUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs the host, never the path or query, and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(() => {
      warnIfUnsafeStoredBaseUrl('http://127.0.0.1:11434/v1?token=secret-value')
    }).not.toThrow()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledTimes(1)
    })

    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('127.0.0.1:11434')
    expect(message).not.toContain('secret-value')
  })

  it('stays quiet for an allowed or absent base URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    warnIfUnsafeStoredBaseUrl(undefined)
    warnIfUnsafeStoredBaseUrl('http://192.168.1.50:11434/v1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(warn).not.toHaveBeenCalled()
  })
})
