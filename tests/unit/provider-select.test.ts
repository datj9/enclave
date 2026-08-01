import { describe, expect, it } from 'vitest'
import { selectProvider, type ProviderCredentials } from '@/lib/providers'
import { HttpError } from '@/lib/http'

/**
 * Decision #10 — `userKey ?? instanceKey` — as a pure function, so key precedence is proven with
 * no environment and no network. S7 supplies the `userKeys` map; S6 always passes it empty.
 */

const BASE: ProviderCredentials = {
  instanceAnthropicKey: undefined,
  instanceOpenAiKey: undefined,
  openAiBaseUrl: undefined,
  model: 'claude-sonnet-4-6',
  userKeys: {},
}

describe('selectProvider', () => {
  it('uses the instance Anthropic key when only that is configured', () => {
    const selection = selectProvider({ ...BASE, instanceAnthropicKey: 'instance-anthropic' })

    expect(selection.provider.id).toBe('anthropic')
    expect(selection.apiKey).toBe('instance-anthropic')
    expect(selection.usedInstanceKey).toBe(true)
    expect(selection.baseUrl).toBeUndefined()
  })

  it("prefers the user's own Anthropic key over the instance key", () => {
    const selection = selectProvider({
      ...BASE,
      instanceAnthropicKey: 'instance-anthropic',
      userKeys: { anthropic: 'user-anthropic' },
    })

    expect(selection.apiKey).toBe('user-anthropic')
    expect(selection.usedInstanceKey).toBe(false)
  })

  it('falls back to the OpenAI-compatible provider when there is no Anthropic key', () => {
    const selection = selectProvider({
      ...BASE,
      instanceOpenAiKey: 'instance-openai',
      openAiBaseUrl: 'http://localhost:11434/v1',
    })

    expect(selection.provider.id).toBe('openai-compatible')
    expect(selection.apiKey).toBe('instance-openai')
    expect(selection.baseUrl).toBe('http://localhost:11434/v1')
    expect(selection.usedInstanceKey).toBe(true)
  })

  it("prefers the user's own OpenAI-compatible key over the instance key", () => {
    const selection = selectProvider({
      ...BASE,
      instanceOpenAiKey: 'instance-openai',
      userKeys: { 'openai-compatible': 'user-openai' },
    })

    expect(selection.apiKey).toBe('user-openai')
    expect(selection.usedInstanceKey).toBe(false)
  })

  it('prefers Anthropic when both providers are configured', () => {
    const selection = selectProvider({
      ...BASE,
      instanceAnthropicKey: 'instance-anthropic',
      instanceOpenAiKey: 'instance-openai',
    })

    expect(selection.provider.id).toBe('anthropic')
  })

  it('carries the configured model through unchanged', () => {
    const selection = selectProvider({
      ...BASE,
      instanceAnthropicKey: 'k',
      model: 'qwen2.5-coder:7b',
    })

    expect(selection.model).toBe('qwen2.5-coder:7b')
  })

  it('rejects with PROVIDER_KEY_INVALID when no key exists anywhere', () => {
    let thrown: unknown
    try {
      selectProvider(BASE)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HttpError)
    expect(thrown).toMatchObject({ code: 'PROVIDER_KEY_INVALID', status: 400 })
  })

  it('names no key material in the message it shows the user', () => {
    expect(() => selectProvider(BASE)).toThrow(/No model provider is configured/)
  })
})
