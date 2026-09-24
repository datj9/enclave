import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'
import type { ArtifactProvider } from '@/lib/providers'
import { anthropicCompatibleProvider, createAnthropicClient } from '@/lib/providers/anthropic'
import { fetchWithoutRedirects, type FetchLike } from '@/lib/providers/base-url'
import { createOpenAiClient, openAiCompatibleProvider } from '@/lib/providers/openai-compatible'

/**
 * A user's base URL is checked when it is stored, but a public host could still answer with a
 * redirect to an internal address. These run the real SDKs against a local server that does
 * exactly that and assert nothing follows it.
 */

const METADATA_URL = 'http://169.254.169.254/latest/meta-data/'

let redirector: Server
let target: Server
let redirectorUrl = ''
let targetUrl = ''
let targetHits = 0
let redirectLocation = ''

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

beforeAll(async () => {
  target = createServer((_request, response) => {
    targetHits += 1
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  redirector = createServer((request, response) => {
    request.resume()
    response.writeHead(302, { location: redirectLocation }).end()
  })
  targetUrl = await listen(target)
  redirectorUrl = await listen(redirector)
})

afterAll(() => {
  redirector.close()
  target.close()
})

beforeEach(() => {
  targetHits = 0
  redirectLocation = METADATA_URL
})

interface SeenRequest {
  readonly url: string
  readonly redirect: RequestRedirect | undefined
}

/**
 * A transport that records every URL the SDK asks for and the redirect mode, then really fetches
 * it. A followed redirect happens inside `fetch`, so the mode is what proves it was not followed.
 */
function recordingFetch(): { readonly spy: FetchLike; readonly seen: SeenRequest[] } {
  const seen: SeenRequest[] = []
  const spy: FetchLike = (input, init) => {
    seen.push({
      url: input instanceof Request ? input.url : String(input),
      redirect: init?.redirect,
    })
    return globalThis.fetch(input, init)
  }
  return { spy, seen }
}

async function drain(provider: ArtifactProvider, baseUrl: string): Promise<unknown> {
  try {
    for await (const _delta of provider.generate({
      prompt: 'p',
      model: 'm',
      apiKey: 'user-key-123456',
      baseUrl,
      signal: new AbortController().signal,
    })) {
      void _delta
    }
  } catch (error) {
    return error
  }
  return undefined
}

describe('clients built from a user base URL', () => {
  it.each([
    ['anthropic-compatible', anthropicCompatibleProvider],
    ['openai-compatible', openAiCompatibleProvider],
  ] as const)(
    '%s does not follow a 302 and fails with the provider error envelope',
    async (_name, provider) => {
      redirectLocation = `${targetUrl}/stolen`

      const error = await drain(provider, `${redirectorUrl}/v1`)

      expect(targetHits).toBe(0)
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).status).toBe(502)
    },
  )

  it('anthropic-compatible never requests the metadata address a 302 points at', async () => {
    const { spy, seen } = recordingFetch()
    const client = createAnthropicClient('user-key-123456', `${redirectorUrl}/v1`, spy)

    await expect(
      client.messages.create({ model: 'm', max_tokens: 1, messages: [] }),
    ).rejects.toBeDefined()
    expect(seen).toEqual([{ url: expect.stringContaining(redirectorUrl), redirect: 'manual' }])
  })

  it('openai-compatible never requests the metadata address a 302 points at', async () => {
    const { spy, seen } = recordingFetch()
    const client = createOpenAiClient('user-key-123456', `${redirectorUrl}/v1`, spy)

    await expect(client.chat.completions.create({ model: 'm', messages: [] })).rejects.toBeDefined()
    expect(seen).toEqual([{ url: expect.stringContaining(redirectorUrl), redirect: 'manual' }])
  })
})

describe('fetchWithoutRedirects', () => {
  it('asks the transport not to follow and refuses any 3xx', async () => {
    const baseFetch = vi.fn<FetchLike>(() =>
      Promise.resolve(new Response(null, { status: 307, headers: { location: METADATA_URL } })),
    )

    await expect(fetchWithoutRedirects(baseFetch)('https://gw.example.com/v1')).rejects.toThrow(
      /redirect/,
    )
    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(baseFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('passes an ordinary response through', async () => {
    const baseFetch = vi.fn<FetchLike>(() => Promise.resolve(new Response('ok', { status: 200 })))

    const response = await fetchWithoutRedirects(baseFetch)('https://gw.example.com/v1', {
      method: 'POST',
    })

    expect(response.status).toBe(200)
    expect(baseFetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'manual' })
  })
})
