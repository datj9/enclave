import { describe, expect, it } from 'vitest'
import { selectProvider, type ProviderCredentials, type UserProviderCredential } from '@/lib/providers'
import { anthropicCompatibleProvider, anthropicProvider } from '@/lib/providers/anthropic'
import { openAiCompatibleProvider } from '@/lib/providers/openai-compatible'
import { HttpError } from '@/lib/http'

/**
 * Decision #10 — `userKey ?? instanceKey` — as a pure function, so key precedence is proven with
 * no environment and no network. S7 supplies the `userKeys` map; S6 always passes it empty.
 *
 * Extended for the base-URL spec: `anthropic-compatible` is user-only (no instance fallback), and
 * `openai-compatible` carries its base URL from whichever credential actually won.
 */

const BASE: ProviderCredentials = {
  instanceAnthropicKey: undefined,
  instanceOpenAiKey: undefined,
  openAiBaseUrl: undefined,
  model: 'claude-sonnet-4-6',
  userKeys: {},
}

function credential(apiKey: string, baseUrl?: string): UserProviderCredential {
  return { apiKey, baseUrl }
}

describe('selectProvider', () => {
  it('uses the instance Anthropic key when only that is configured', () => {
    const selection = selectProvider({ ...BASE, instanceAnthropicKey: 'instance-anthropic' })

    expect(selection.provider).toBe(anthropicProvider)
    expect(selection.apiKey).toBe('instance-anthropic')
    expect(selection.usedInstanceKey).toBe(true)
    expect(selection.baseUrl).toBeUndefined()
  })

  it("prefers the user's own Anthropic key over the instance key", () => {
    const selection = selectProvider({
      ...BASE,
      instanceAnthropicKey: 'instance-anthropic',
      userKeys: { anthropic: credential('user-anthropic') },
    })

    expect(selection.apiKey).toBe('user-anthropic')
    expect(selection.usedInstanceKey).toBe(false)
  })

  it('never sets a base URL for plain anthropic, even if the stored credential carries one', () => {
    const selection = selectProvider({
      ...BASE,
      userKeys: { anthropic: credential('user-anthropic', 'https://ignored.example.com') },
    })

    expect(selection.provider.id).toBe('anthropic')
    expect(selection.baseUrl).toBeUndefined()
  })

  it('selects anthropicCompatibleProvider for a user anthropic-compatible key, with its own base URL', () => {
    const selection = selectProvider({
      ...BASE,
      userKeys: { 'anthropic-compatible': credential('sk-u', 'https://gw.example.com') },
    })

    expect(selection.provider).toBe(anthropicCompatibleProvider)
    expect(selection.apiKey).toBe('sk-u')
    expect(selection.baseUrl).toBe('https://gw.example.com')
    expect(selection.usedInstanceKey).toBe(false)
  })

  it('has no instance fallback for anthropic-compatible: without a user key it falls through', () => {
    const selection = selectProvider({
      ...BASE,
      instanceOpenAiKey: 'instance-openai',
      openAiBaseUrl: 'https://api.openai.com/v1',
    })

    expect(selection.provider.id).toBe('openai-compatible')
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

  it("prefers the user's own OpenAI-compatible key and its base URL over the instance's", () => {
    const selection = selectProvider({
      ...BASE,
      instanceOpenAiKey: 'instance-openai',
      openAiBaseUrl: 'https://api.openai.com/v1',
      userKeys: { 'openai-compatible': credential('user-openai', 'https://gw.example.com') },
    })

    expect(selection.apiKey).toBe('user-openai')
    expect(selection.baseUrl).toBe('https://gw.example.com')
    expect(selection.usedInstanceKey).toBe(false)
  })

  it('falls back to the instance base URL when the user openai-compatible key has none', () => {
    const selection = selectProvider({
      ...BASE,
      openAiBaseUrl: 'https://api.openai.com/v1',
      userKeys: { 'openai-compatible': credential('user-openai', undefined) },
    })

    expect(selection.baseUrl).toBeUndefined()
  })

  it('prefers Anthropic when both anthropic and openai-compatible are configured', () => {
    const selection = selectProvider({
      ...BASE,
      instanceAnthropicKey: 'instance-anthropic',
      instanceOpenAiKey: 'instance-openai',
    })

    expect(selection.provider.id).toBe('anthropic')
  })

  it('prefers a user anthropic key over a user anthropic-compatible key', () => {
    const selection = selectProvider({
      ...BASE,
      userKeys: {
        anthropic: credential('user-anthropic'),
        'anthropic-compatible': credential('sk-u', 'https://gw.example.com'),
      },
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

  it('matches the spec worked example exactly', () => {
    const selection = selectProvider({
      instanceAnthropicKey: undefined,
      instanceOpenAiKey: 'sk-inst',
      openAiBaseUrl: 'https://api.openai.com/v1',
      model: 'm',
      userKeys: { 'anthropic-compatible': { apiKey: 'sk-u', baseUrl: 'https://gw.example.com' } },
    })

    expect(selection).toEqual({
      provider: anthropicCompatibleProvider,
      apiKey: 'sk-u',
      model: 'm',
      baseUrl: 'https://gw.example.com',
      usedInstanceKey: false,
    })
  })

  it('never returns the openai-compatible provider without going through openai-compatible', () => {
    const selection = selectProvider({ ...BASE, instanceOpenAiKey: 'k' })
    expect(selection.provider).toBe(openAiCompatibleProvider)
  })
})
