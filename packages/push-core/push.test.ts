import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PushError } from './src/errors.ts'
import { push } from './src/push.ts'
import type { PushOptions } from './src/types.ts'

interface WireFileShape {
  readonly path: string
  readonly content?: string
  readonly contentBase64?: string
}

interface RequestBodyShape {
  readonly title: string
  readonly visibility: string
  readonly files: readonly WireFileShape[]
}

const CREATED_ARTIFACT = {
  id: '3f2a91c4-2f1e-4a0b-9d43-5c9d0f0a1b2c',
  versionId: '8b1d0e77-1c22-4b6a-9f3e-0a5d7c2e4f10',
  viewUrl: 'https://3f2a91c4.artifacts.example.com',
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as unknown as Response
}

describe('push', () => {
  const originalFetch = globalThis.fetch
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>()
  let directory = ''

  function requestOf(callIndex: number): { url: string; init: RequestInit } {
    const call = fetchMock.mock.calls[callIndex]
    if (call === undefined) throw new Error(`fetch was not called ${String(callIndex + 1)} time(s)`)
    return { url: call[0], init: call[1] }
  }

  function bodyOf(init: RequestInit): RequestBodyShape {
    return JSON.parse(String(init.body)) as RequestBodyShape
  }

  async function rejectionOf(options: PushOptions): Promise<PushError> {
    try {
      await push(options)
    } catch (error) {
      if (error instanceof PushError) return error
      throw error
    }
    throw new Error('push resolved but a PushError was expected')
  }

  function optionsFor(overrides: Partial<PushOptions> = {}): PushOptions {
    return {
      directory,
      host: 'enclave.example.com',
      token: 'secret-token-value',
      ...overrides,
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'push-'))
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fetchMock.mockReset()
    rmSync(directory, { recursive: true, force: true })
  })

  it('posts title visibility and files to the create endpoint', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    await push(optionsFor({ host: 'h', title: 'My page', visibility: 'org' }))

    const { url, init } = requestOf(0)
    expect(url).toBe('https://h/api/v1/artifacts')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer secret-token-value',
    )
    expect(bodyOf(init)).toEqual({
      title: 'My page',
      visibility: 'org',
      files: [{ path: 'index.html', content: '<!doctype html>' }],
    })
  })

  it('sends utf8 content for a text file', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    await push(optionsFor())

    const wireFile = bodyOf(requestOf(0).init).files[0]
    expect(wireFile?.content).toBe('<!doctype html>')
    expect(wireFile?.contentBase64).toBeUndefined()
  })

  it('sends base64 for a binary file', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'logo.png'), PNG_BYTES)
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    await push(optionsFor())

    const logo = bodyOf(requestOf(0).init).files.find((file) => file.path === 'logo.png')
    expect(logo?.contentBase64).toBe(PNG_BYTES.toString('base64'))
    expect(logo?.content).toBeUndefined()
  })

  it('uses http for localhost', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    await push(optionsFor({ host: 'localhost:3000' }))

    expect(requestOf(0).url.startsWith('http://localhost:3000')).toBe(true)
  })

  it('uses https for a real host', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    await push(optionsFor())

    expect(requestOf(0).url.startsWith('https://enclave.example.com')).toBe(true)
  })

  it('accepts a host that already carries a scheme', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    await push(optionsFor({ host: 'https://enclave.example.com' }))

    expect(requestOf(0).url).toBe('https://enclave.example.com/api/v1/artifacts')
  })

  it('throws NOTHING_TO_UPLOAD for an empty directory', async () => {
    const error = await rejectionOf(optionsFor())

    expect(error.code).toBe('NOTHING_TO_UPLOAD')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws ENTRY_MISSING when index.html was skipped', async () => {
    writeFileSync(join(directory, 'app.js'), 'console.log(1)')

    const error = await rejectionOf(optionsFor())

    expect(error.code).toBe('ENTRY_MISSING')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps 401 to UNAUTHORIZED', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(
      jsonResponse(401, { error: { code: 'BAD_TOKEN', message: 'that token was rejected' } }),
    )

    const error = await rejectionOf(optionsFor())

    expect(error.code).toBe('UNAUTHORIZED')
    expect(error.message).toBe('that token was rejected')
  })

  it('maps a 413 body to BUNDLE_TOO_LARGE with details', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockResolvedValue(
      jsonResponse(413, {
        error: {
          code: 'BUNDLE_TOO_LARGE',
          message: 'the bundle is too large',
          details: { maxFileBytes: 2_097_152 },
        },
      }),
    )

    const error = await rejectionOf(optionsFor())

    expect(error.code).toBe('BUNDLE_TOO_LARGE')
    expect(error.details['maxFileBytes']).toBe(2_097_152)
  })

  it('maps a fetch rejection to NETWORK_ERROR', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))

    const error = await rejectionOf(optionsFor())

    expect(error.code).toBe('NETWORK_ERROR')
    expect(error.details).toEqual({ host: 'enclave.example.com' })
  })

  it('returns uploaded and skipped lists on success', async () => {
    writeFileSync(join(directory, 'index.html'), '<!doctype html>')
    writeFileSync(join(directory, 'app.js'), 'console.log(1)')
    writeFileSync(join(directory, 'app.js.map'), '{}')
    fetchMock.mockResolvedValue(jsonResponse(201, CREATED_ARTIFACT))

    const result = await push(optionsFor())

    expect(result.uploaded).toEqual(['app.js', 'index.html'])
    expect(result.skipped).toEqual([{ path: 'app.js.map', reason: 'unsupported_extension' }])
    expect(result.versionNo).toBe(1)
    expect(result.artifactId).toBe(CREATED_ARTIFACT.id)
  })
})
