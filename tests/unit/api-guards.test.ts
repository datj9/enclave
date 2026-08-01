import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readJsonBody, requireJsonContentType, requireSessionUser } from '@/lib/api/guards'
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

  it('rejects a request with no content-type at all', () => {
    const request = new Request('http://app.example.com/api/v1/artifacts', { method: 'POST' })

    expect(() => requireJsonContentType(request)).toThrow(HttpError)
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
