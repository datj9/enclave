import { describe, expect, it } from 'vitest'
import { MAX_BASE_URL_LENGTH, normaliseBaseUrl } from '@/lib/providers/base-url'
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

  it('accepts a loopback address for a local model server', () => {
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
