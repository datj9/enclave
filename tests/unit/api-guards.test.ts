import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/env'
import {
  readJsonBody,
  requireJsonContentType,
  requireSameOriginRequest,
  requireSessionUser,
} from '@/lib/api/guards'
import { getSessionUser } from '@/lib/auth/session'
import { HttpError } from '@/lib/http'

vi.mock('@/lib/auth/session', () => ({ getSessionUser: vi.fn() }))

const getSessionUserMock = vi.mocked(getSessionUser)

const SESSION_USER = {
  id: '7f3e0000-0000-4000-8000-000000000001',
  email: 'ops@example.com',
  role: 'admin',
  isActive: true,
} as const

function jsonRequest(body: string): Request {
  return new Request('http://app.example.com/api/v1/artifacts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

beforeEach(() => {
  getSessionUserMock.mockReset()
})

describe('requireSessionUser', () => {
  it('returns the signed-in user', async () => {
    getSessionUserMock.mockResolvedValue(SESSION_USER)

    await expect(requireSessionUser()).resolves.toEqual(SESSION_USER)
  })

  it('throws UNAUTHENTICATED without a session', async () => {
    getSessionUserMock.mockResolvedValue(null)

    await expect(requireSessionUser()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
    })
  })
})

describe('requireJsonContentType', () => {
  it('accepts application/json with a charset', () => {
    const request = new Request('http://app.example.com/api/v1/artifacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{}',
    })

    expect(() => requireJsonContentType(request)).not.toThrow()
  })

  it.each([
    ['a form post, which is the CSRF shape this blocks', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data'],
    ['plain text', 'text/plain'],
  ])('rejects %s', (_label, contentType) => {
    const request = new Request('http://app.example.com/api/v1/artifacts', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: 'title=x',
    })

    expect(() => requireJsonContentType(request)).toThrow(HttpError)
  })

  it.each([
    ['an uppercase type', 'Application/JSON'],
    ['whitespace before the parameters', 'application/json ; charset=utf-8'],
  ])('accepts %s', (_label, contentType) => {
    const request = new Request('http://app.example.com/api/v1/artifacts', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: '{}',
    })

    expect(() => requireJsonContentType(request)).not.toThrow()
  })

  it.each([
    // CORS-simple (essence text/plain), so a cross-site page can send it without a preflight —
    // the substring match this replaced let it through.
    ['text/plain smuggling the JSON type into a parameter', 'text/plain;application/json'],
    ['a JSON-suffixed type that is not JSON itself', 'application/json-patch+json'],
    ['the type as a prefix of something else', 'application/jsonx'],
  ])('rejects %s', (_label, contentType) => {
    const request = new Request('http://app.example.com/api/v1/artifacts', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: '{}',
    })

    expect(() => requireJsonContentType(request)).toThrow(HttpError)
  })

  it('refuses a cross-site request before looking at the content type', () => {
    const request = new Request('http://app.example.com/api/v1/artifacts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: '{}',
    })

    expect(() => requireJsonContentType(request)).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', status: 403 }),
    )
  })

  it('rejects a request with no content-type at all', () => {
    const request = new Request('http://app.example.com/api/v1/artifacts', { method: 'POST' })

    expect(() => requireJsonContentType(request)).toThrow(HttpError)
  })
})

const APP_ORIGIN = new URL(env.APP_URL).origin
const ARTIFACT_ORIGIN = new URL(
  env.ARTIFACT_ORIGIN_TEMPLATE.replaceAll('{id}', '7f3e0000-0000-4000-8000-0000000000aa'),
).origin

function writeRequest(headers: Record<string, string>, method = 'POST'): Request {
  return new Request(`${APP_ORIGIN}/api/v1/settings/keys`, { method, headers })
}

describe('requireSameOriginRequest', () => {
  it.each([
    ['no browser headers at all (CLI, curl, Playwright request)', {}],
    ['Sec-Fetch-Site same-origin', { 'sec-fetch-site': 'same-origin' }],
    ['Sec-Fetch-Site none (user-initiated)', { 'sec-fetch-site': 'none' }],
    ['the APP_URL origin', { origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin' }],
    ['an Origin without Sec-Fetch-Site (older browsers)', { origin: APP_ORIGIN }],
  ])('allows %s', (_label, headers) => {
    expect(() => requireSameOriginRequest(writeRequest(headers))).not.toThrow()
  })

  it('allows the request host when the app is reached on a name other than APP_URL', () => {
    const request = new Request('http://192.168.1.20:3000/api/v1/settings/keys', {
      method: 'POST',
      headers: { host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' },
    })

    expect(() => requireSameOriginRequest(request)).not.toThrow()
  })

  it('honours X-Forwarded-Host, as the proxy reports the public host', () => {
    const request = new Request('http://127.0.0.1:3000/api/v1/settings/keys', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:3000',
        'x-forwarded-host': 'enclave.lan',
        origin: 'https://enclave.lan',
      },
    })

    expect(() => requireSameOriginRequest(request)).not.toThrow()
  })

  it('matches a request host that spells out the default port', () => {
    const request = new Request('http://127.0.0.1:3000/api/v1/settings/keys', {
      method: 'POST',
      headers: { host: 'enclave.lan:443', origin: 'https://enclave.lan' },
    })

    expect(() => requireSameOriginRequest(request)).not.toThrow()
  })

  it.each([
    ['a different port', { host: 'enclave.lan:8443', origin: 'https://enclave.lan' }],
    ['the default port of the other scheme', { host: 'enclave.lan:80', origin: 'https://enclave.lan' }],
    ['userinfo smuggled into the host', { host: 'evil.example@enclave.lan', origin: 'https://enclave.lan' }],
  ])('does not match a request host with %s', (_label, headers) => {
    const request = new Request('http://127.0.0.1:3000/api/v1/settings/keys', {
      method: 'POST',
      headers,
    })

    expect(() => requireSameOriginRequest(request)).toThrow(HttpError)
  })

  it.each([
    [
      'an artifact origin, which is same-site with the app',
      { origin: ARTIFACT_ORIGIN, 'sec-fetch-site': 'same-site' },
    ],
    ['Sec-Fetch-Site same-site even without an Origin', { 'sec-fetch-site': 'same-site' }],
    ['Sec-Fetch-Site cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['a foreign Origin without Sec-Fetch-Site', { origin: 'https://evil.example' }],
    [
      'a foreign Origin claiming same-origin',
      { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
    ],
    ['Origin: null from a sandboxed frame', { origin: 'null' }],
    ['an unparseable Origin', { origin: 'not a url' }],
  ])('refuses %s with the 403 envelope', (_label, headers) => {
    const error = (() => {
      try {
        requireSameOriginRequest(writeRequest(headers))
      } catch (thrown) {
        return thrown
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('applies to %s', (method) => {
    expect(() =>
      requireSameOriginRequest(writeRequest({ 'sec-fetch-site': 'cross-site' }, method)),
    ).toThrow(HttpError)
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])('leaves the safe method %s alone', (method) => {
    expect(() =>
      requireSameOriginRequest(writeRequest({ origin: 'https://evil.example' }, method)),
    ).not.toThrow()
  })

  it('exempts a bearer request, which no page can forge cross-site', () => {
    const request = writeRequest({
      authorization: 'Bearer enc_abc',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    })

    expect(() => requireSameOriginRequest(request)).not.toThrow()
  })

  it('does not exempt a non-bearer Authorization scheme', () => {
    const request = writeRequest({
      authorization: 'Basic dXNlcjpwYXNz',
      'sec-fetch-site': 'cross-site',
    })

    expect(() => requireSameOriginRequest(request)).toThrow(HttpError)
  })
})

describe('readJsonBody', () => {
  it('parses a JSON body', async () => {
    await expect(readJsonBody(jsonRequest('{"title":"x"}'))).resolves.toEqual({ title: 'x' })
  })

  it('throws VALIDATION_FAILED on malformed JSON without leaking the parser error', async () => {
    const error = await readJsonBody(jsonRequest('{not json')).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
    expect((error as HttpError).message).toBe('Request body is not valid JSON')
  })
})
