import { describe, expect, it } from 'vitest'
import {
  ERROR_STATUS,
  HttpError,
  jsonData,
  jsonError,
  seeOther,
  toErrorResponse,
  type ErrorBody,
  type ErrorCode,
} from '@/lib/http'

async function readJson<TBody>(response: Response): Promise<TBody> {
  return (await response.json()) as TBody
}

describe('jsonData', () => {
  it('wraps the payload in the data envelope', async () => {
    const response = jsonData({ status: 'ok' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    await expect(readJson(response)).resolves.toEqual({ data: { status: 'ok' } })
  })

  it('honours an explicit status and extra headers', () => {
    const response = jsonData({ id: 'abc' }, 201, { location: '/api/v1/artifacts/abc' })

    expect(response.status).toBe(201)
    expect(response.headers.get('location')).toBe('/api/v1/artifacts/abc')
  })
})

describe('jsonError', () => {
  it('wraps code and message in the error envelope', async () => {
    const response = jsonError('NOT_FOUND', 'No such artifact')

    expect(response.status).toBe(404)
    await expect(readJson<ErrorBody>(response)).resolves.toEqual({
      error: { code: 'NOT_FOUND', message: 'No such artifact' },
    })
  })

  it('omits details entirely when none are given', async () => {
    const body = await readJson<ErrorBody>(jsonError('FORBIDDEN', 'Nope'))

    expect('details' in body.error).toBe(false)
  })

  it('includes details when given', async () => {
    const response = jsonError('VALIDATION_FAILED', 'Bad bundle', {
      details: { duplicatePaths: ['index.html'] },
    })

    await expect(readJson<ErrorBody>(response)).resolves.toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Bad bundle',
        details: { duplicatePaths: ['index.html'] },
      },
    })
  })

  it('allows a status override, as /setup needs for 409', () => {
    expect(jsonError('VALIDATION_FAILED', 'Already done', { status: 409 }).status).toBe(409)
  })

  const statusExpectations: ReadonlyArray<readonly [ErrorCode, number]> = [
    ['UNAUTHENTICATED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['VALIDATION_FAILED', 422],
    ['BUNDLE_TOO_LARGE', 413],
    ['FILE_TYPE_NOT_ALLOWED', 422],
    ['PATH_INVALID', 422],
    ['ENTRY_MISSING', 422],
    ['RATE_LIMITED', 429],
    ['QUOTA_EXCEEDED', 429],
    ['PROVIDER_KEY_INVALID', 400],
    ['PROVIDER_RATE_LIMITED', 502],
    ['PROVIDER_REFUSED', 422],
    ['MALFORMED_MODEL_OUTPUT', 502],
    ['STORAGE_UNAVAILABLE', 503],
  ]

  it.each(statusExpectations)('maps %s to %i per §5.3', (code, expectedStatus) => {
    expect(ERROR_STATUS[code]).toBe(expectedStatus)
    expect(jsonError(code, 'message').status).toBe(expectedStatus)
  })
})

describe('toErrorResponse', () => {
  it('renders an HttpError with its code, status and headers', async () => {
    const response = toErrorResponse(
      new HttpError('RATE_LIMITED', 'Slow down', { headers: { 'retry-after': '42' } }),
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('42')
    await expect(readJson<ErrorBody>(response)).resolves.toEqual({
      error: { code: 'RATE_LIMITED', message: 'Slow down' },
    })
  })

  it('preserves HttpError details', async () => {
    const body = await readJson<ErrorBody>(
      toErrorResponse(new HttpError('VALIDATION_FAILED', 'Bad', { details: { field: 'email' } })),
    )

    expect(body.error.details).toEqual({ field: 'email' })
  })

  it('collapses an unexpected throwable to a generic 500 that leaks nothing', async () => {
    const response = toErrorResponse(new Error('connect ECONNREFUSED 10.0.0.4:5432 in /app/src/db'))

    expect(response.status).toBe(500)
    const body = await readJson<ErrorBody>(response)
    expect(body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(body)).not.toContain('/app/src/db')
  })

  it('collapses a non-Error throwable too', async () => {
    expect(toErrorResponse('boom').status).toBe(500)
  })
})

describe('seeOther', () => {
  it('returns a 303 with the location', () => {
    const response = seeOther('/dashboard')

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/dashboard')
  })

  it('carries extra headers such as set-cookie', () => {
    const response = seeOther('/dashboard', { 'set-cookie': 'enclave_session=token' })

    expect(response.headers.get('set-cookie')).toBe('enclave_session=token')
  })
})
