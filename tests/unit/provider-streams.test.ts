import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileBlockParser, type ParseEvent } from '@/lib/bundle/parse-file-blocks'
import { HttpError } from '@/lib/http'
import type { ArtifactProvider, ProviderUsage } from '@/lib/providers'
import { anthropicProvider } from '@/lib/providers/anthropic'
import { openAiCompatibleProvider } from '@/lib/providers/openai-compatible'

/**
 * Both §5.6 implementations, with the vendor SDKs replaced. No network, no API key.
 *
 * The last suite is the S6 acceptance criterion that the same parser passes identical fixture
 * tests for both providers: one fixture, two wire formats, byte-identical result.
 */

const mocks = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openAiCreate: vi.fn(),
  anthropicOptions: [] as Record<string, unknown>[],
  openAiOptions: [] as Record<string, unknown>[],
}))

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    readonly messages = { create: mocks.anthropicCreate }
    constructor(options: Record<string, unknown>) {
      mocks.anthropicOptions.push(options)
    }
  },
}))

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    readonly chat = { completions: { create: mocks.openAiCreate } }
    constructor(options: Record<string, unknown>) {
      mocks.openAiOptions.push(options)
    }
  },
}))

const FIXTURE =
  '<file path="index.html">\n<!doctype html><h1>Hi</h1>\n</file>\n' +
  '<file path="app.js">\nconsole.log(1)\n</file>'

const TOKENS_IN = 11
const TOKENS_OUT = 220

function asStream<TChunk>(chunks: readonly TChunk[]): AsyncIterable<TChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function anthropicStream(texts: readonly string[]): AsyncIterable<unknown> {
  return asStream([
    { type: 'message_start', message: { usage: { input_tokens: TOKENS_IN } } },
    ...texts.map((text) => ({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: TOKENS_OUT },
    },
  ])
}

function openAiStream(texts: readonly string[]): AsyncIterable<unknown> {
  return asStream([
    ...texts.map((text) => ({ choices: [{ delta: { content: text }, finish_reason: null }] })),
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT },
    },
  ])
}

async function collect(
  provider: ArtifactProvider,
  overrides: { readonly onUsage?: (usage: ProviderUsage) => void } = {},
): Promise<string[]> {
  const deltas: string[] = []
  for await (const delta of provider.generate({
    prompt: 'a countdown timer to new year',
    model: 'test-model',
    apiKey: 'test-key',
    signal: new AbortController().signal,
    ...overrides,
  })) {
    deltas.push(delta)
  }
  return deltas
}

async function thrownBy(run: () => Promise<unknown>): Promise<HttpError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected the provider to throw')
}

beforeEach(() => {
  mocks.anthropicCreate.mockReset()
  mocks.openAiCreate.mockReset()
  mocks.anthropicOptions.length = 0
  mocks.openAiOptions.length = 0
})

describe('anthropicProvider', () => {
  it('yields the text deltas and nothing else', async () => {
    mocks.anthropicCreate.mockResolvedValue(anthropicStream(['<file ', 'path="a">']))

    expect(await collect(anthropicProvider)).toEqual(['<file ', 'path="a">'])
  })

  it('never lets the SDK retry a failed call', async () => {
    mocks.anthropicCreate.mockResolvedValue(anthropicStream([]))
    await collect(anthropicProvider)

    expect(mocks.anthropicOptions[0]).toMatchObject({ maxRetries: 0 })
  })

  it('sends the prompt as the user turn and the format rules as the system prompt', async () => {
    mocks.anthropicCreate.mockResolvedValue(anthropicStream([]))
    await collect(anthropicProvider)

    const [body] = mocks.anthropicCreate.mock.calls[0] as [Record<string, unknown>]
    expect(body.messages).toEqual([{ role: 'user', content: 'a countdown timer to new year' }])
    expect(String(body.system)).toContain('<file path="index.html">')
  })

  it('reports token usage once the stream ends', async () => {
    mocks.anthropicCreate.mockResolvedValue(anthropicStream(['x']))
    const usages: ProviderUsage[] = []

    await collect(anthropicProvider, { onUsage: (usage) => usages.push(usage) })

    expect(usages).toEqual([{ tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT }])
  })

  it('maps a rejected key to PROVIDER_KEY_INVALID', async () => {
    mocks.anthropicCreate.mockRejectedValue({ status: 401 })

    expect(await thrownBy(() => collect(anthropicProvider))).toMatchObject({
      code: 'PROVIDER_KEY_INVALID',
      status: 400,
    })
  })

  it('maps a provider 429 to PROVIDER_RATE_LIMITED without retrying', async () => {
    mocks.anthropicCreate.mockRejectedValue({ status: 429 })

    expect(await thrownBy(() => collect(anthropicProvider))).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      status: 502,
    })
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1)
  })

  it('maps an unrecognised provider failure to a 502 that names no internals', async () => {
    mocks.anthropicCreate.mockRejectedValue(new Error('socket hang up at /srv/enclave/node_modules'))
    const error = await thrownBy(() => collect(anthropicProvider))

    expect(error.status).toBe(502)
    expect(error.message).toBe('The model provider could not be reached')
  })

  it('reports a refusal stop reason as PROVIDER_REFUSED', async () => {
    mocks.anthropicCreate.mockResolvedValue(
      asStream([
        { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } },
      ]),
    )

    expect(await thrownBy(() => collect(anthropicProvider))).toMatchObject({
      code: 'PROVIDER_REFUSED',
      status: 422,
    })
  })

  it('rethrows an abort untouched so the caller can tell it apart from a provider fault', async () => {
    const controller = new AbortController()
    const abortError = new Error('The operation was aborted')
    mocks.anthropicCreate.mockImplementation(() => {
      controller.abort()
      return Promise.reject(abortError)
    })

    const iterable = anthropicProvider.generate({
      prompt: 'p',
      model: 'm',
      apiKey: 'k',
      signal: controller.signal,
    })

    await expect(async () => {
      for await (const _delta of iterable) void _delta
    }).rejects.toBe(abortError)
  })
})

describe('openAiCompatibleProvider', () => {
  it('yields the text deltas and skips empty ones', async () => {
    mocks.openAiCreate.mockResolvedValue(
      asStream([
        { choices: [{ delta: { content: '' }, finish_reason: null }] },
        { choices: [{ delta: { content: '<file' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: null }] },
        { choices: [] },
      ]),
    )

    expect(await collect(openAiCompatibleProvider)).toEqual(['<file'])
  })

  it('points the client at the configured base URL with retries off', async () => {
    mocks.openAiCreate.mockResolvedValue(openAiStream([]))

    await collect(openAiCompatibleProvider)
    expect(mocks.openAiOptions[0]).toMatchObject({ maxRetries: 0, baseURL: null })

    for await (const _delta of openAiCompatibleProvider.generate({
      prompt: 'p',
      model: 'm',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      signal: new AbortController().signal,
    })) {
      void _delta
    }
    expect(mocks.openAiOptions[1]).toMatchObject({ baseURL: 'http://localhost:11434/v1' })
  })

  it('sends the format rules as a system message', async () => {
    mocks.openAiCreate.mockResolvedValue(openAiStream([]))
    await collect(openAiCompatibleProvider)

    const [body] = mocks.openAiCreate.mock.calls[0] as [{ messages: { role: string }[] }]
    expect(body.messages.map((message) => message.role)).toEqual(['system', 'user'])
  })

  it('reports token usage from the final usage chunk', async () => {
    mocks.openAiCreate.mockResolvedValue(openAiStream(['x']))
    const usages: ProviderUsage[] = []

    await collect(openAiCompatibleProvider, { onUsage: (usage) => usages.push(usage) })

    expect(usages).toEqual([{ tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT }])
  })

  it('shows the model its own words when it refuses', async () => {
    mocks.openAiCreate.mockResolvedValue(
      asStream([
        { choices: [{ delta: { refusal: 'I cannot build that.' }, finish_reason: null }] },
      ]),
    )
    const error = await thrownBy(() => collect(openAiCompatibleProvider))

    expect(error).toMatchObject({ code: 'PROVIDER_REFUSED', status: 422 })
    expect(error.message).toBe('I cannot build that.')
  })

  it('treats a content filter as a refusal', async () => {
    mocks.openAiCreate.mockResolvedValue(
      asStream([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }]),
    )
    const error = await thrownBy(() => collect(openAiCompatibleProvider))

    expect(error.code).toBe('PROVIDER_REFUSED')
    expect(error.message).toBe('The model declined to build this artifact')
  })

  it('maps a rejected key to PROVIDER_KEY_INVALID', async () => {
    mocks.openAiCreate.mockRejectedValue({ status: 403 })

    expect((await thrownBy(() => collect(openAiCompatibleProvider))).code).toBe(
      'PROVIDER_KEY_INVALID',
    )
  })

  it('maps a provider 429 to PROVIDER_RATE_LIMITED without retrying', async () => {
    mocks.openAiCreate.mockRejectedValue({ status: 429 })

    expect((await thrownBy(() => collect(openAiCompatibleProvider))).code).toBe(
      'PROVIDER_RATE_LIMITED',
    )
    expect(mocks.openAiCreate).toHaveBeenCalledTimes(1)
  })

  it('rethrows an abort untouched', async () => {
    const controller = new AbortController()
    const abortError = new Error('aborted')
    mocks.openAiCreate.mockImplementation(() => {
      controller.abort()
      return Promise.reject(abortError)
    })

    await expect(async () => {
      for await (const _delta of openAiCompatibleProvider.generate({
        prompt: 'p',
        model: 'm',
        apiKey: 'k',
        signal: controller.signal,
      })) {
        void _delta
      }
    }).rejects.toBe(abortError)
  })
})

describe('the parser is provider-agnostic', () => {
  /** Same fixture, chopped differently by each wire format — the parser may not care. */
  async function parseThrough(provider: ArtifactProvider): Promise<{
    shape: string[]
    files: Record<string, string>
  }> {
    const parser = new FileBlockParser()
    const events: ParseEvent[] = []
    for await (const delta of provider.generate({
      prompt: 'p',
      model: 'm',
      apiKey: 'k',
      signal: new AbortController().signal,
    })) {
      events.push(...parser.push(delta))
    }

    return {
      shape: events.map((event) => `${event.kind}:${event.path}`),
      files: Object.fromEntries(
        parser.finish().map((file) => [file.path, file.content.toString('utf8')]),
      ),
    }
  }

  it('produces identical files and events from both providers', async () => {
    mocks.anthropicCreate.mockResolvedValue(anthropicStream([...FIXTURE]))
    mocks.openAiCreate.mockResolvedValue(
      openAiStream(FIXTURE.match(/[\s\S]{1,7}/g) ?? []),
    )

    const fromAnthropic = await parseThrough(anthropicProvider)
    const fromOpenAi = await parseThrough(openAiCompatibleProvider)

    expect(fromAnthropic.files).toEqual({
      'index.html': '<!doctype html><h1>Hi</h1>',
      'app.js': 'console.log(1)',
    })
    expect(fromOpenAi.files).toEqual(fromAnthropic.files)
    expect(fromOpenAi.shape.filter((entry) => !entry.startsWith('chunk'))).toEqual(
      fromAnthropic.shape.filter((entry) => !entry.startsWith('chunk')),
    )
  })
})
