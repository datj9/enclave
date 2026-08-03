import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiClient } from './src/api-client.ts'

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response
}

describe('apiClient envelope handling', () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>()

  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
  })

  it('get unwraps {data} and returns the inner payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { items: [], nextCursor: null } }))

    const client = apiClient('https://enclave.example.com', 'token')
    const page = await client.get<{ items: unknown[]; nextCursor: string | null }>(
      '/api/v1/artifacts',
    )

    expect(page).toEqual({ items: [], nextCursor: null })
  })

  it('post unwraps {data} and returns the inner payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: { id: 'abc' } }))

    const client = apiClient('https://enclave.example.com', 'token')
    const created = await client.post<{ id: string }>('/api/v1/artifacts', { title: 't' })

    expect(created).toEqual({ id: 'abc' })
  })

  it('patch unwraps {data} and returns the inner payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { id: 'abc', title: 'renamed' } }))

    const client = apiClient('https://enclave.example.com', 'token')
    const updated = await client.patch<{ id: string; title: string }>(
      '/api/v1/artifacts/abc',
      { title: 'renamed' },
    )

    expect(updated).toEqual({ id: 'abc', title: 'renamed' })
  })

  it('throws UNEXPECTED_RESPONSE from get when the envelope is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { items: [] }))

    const client = apiClient('https://enclave.example.com', 'token')

    await expect(client.get('/api/v1/artifacts')).rejects.toMatchObject({
      code: 'UNEXPECTED_RESPONSE',
    })
  })

  it('throws UNEXPECTED_RESPONSE when the body is not an object', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, 'not an object'))

    const client = apiClient('https://enclave.example.com', 'token')

    await expect(client.get('/api/v1/artifacts')).rejects.toBeInstanceOf(ApiError)
  })

  it('remove sends DELETE and reads no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(204, undefined))

    const client = apiClient('https://enclave.example.com', 'token')
    await expect(client.remove('/api/v1/artifacts/abc')).resolves.toBeUndefined()

    const call = fetchMock.mock.calls[0]
    expect(call?.[1]?.method).toBe('DELETE')
  })
})
