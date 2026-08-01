import { describe, expect, it } from 'vitest'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'

function jsonRequest(body: string): Request {
  return new Request('http://localhost:3000/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

function formRequest(fields: Record<string, string>): Request {
  return new Request('http://localhost:3000/api/setup', {
    method: 'POST',
    body: new URLSearchParams(fields),
  })
}

describe('readRequestBody', () => {
  it('reads a JSON body', async () => {
    const body = await readRequestBody(
      jsonRequest(JSON.stringify({ email: 'ops@example.com', password: 'correct-horse-battery' })),
    )

    expect(body).toEqual({ email: 'ops@example.com', password: 'correct-horse-battery' })
  })

  it('reads a urlencoded form body', async () => {
    const body = await readRequestBody(
      formRequest({ email: 'ops@example.com', password: 'correct-horse-battery' }),
    )

    expect(body).toEqual({ email: 'ops@example.com', password: 'correct-horse-battery' })
  })

  it('returns an empty body for malformed JSON instead of throwing', async () => {
    await expect(readRequestBody(jsonRequest('{not json'))).resolves.toEqual({})
  })

  it('returns an empty body for a JSON array or scalar', async () => {
    await expect(readRequestBody(jsonRequest('[1,2]'))).resolves.toEqual({})
    await expect(readRequestBody(jsonRequest('"hello"'))).resolves.toEqual({})
    await expect(readRequestBody(jsonRequest('null'))).resolves.toEqual({})
  })
})

describe('wantsJsonResponse', () => {
  it('is true for a JSON request body', () => {
    expect(wantsJsonResponse(jsonRequest('{}'))).toBe(true)
  })

  it('is true for an Accept: application/json request', () => {
    const request = new Request('http://localhost:3000/api/setup', {
      method: 'POST',
      headers: { accept: 'application/json' },
    })

    expect(wantsJsonResponse(request)).toBe(true)
  })

  it('is false for a browser form post, which expects a redirect', () => {
    const request = new Request('http://localhost:3000/api/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9',
      },
    })

    expect(wantsJsonResponse(request)).toBe(false)
  })

  it('is false when no headers say otherwise', () => {
    expect(
      wantsJsonResponse(new Request('http://localhost:3000/api/setup', { method: 'POST' })),
    ).toBe(false)
  })
})
