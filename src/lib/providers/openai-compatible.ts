import OpenAI from 'openai'

import { env } from '@/env'
import { ARTIFACT_SYSTEM_PROMPT } from '@/prompts/system'
import { fetchWithoutRedirects, type FetchLike } from './base-url'
import { providerRefusal, toProviderError } from './errors'
import type { ArtifactProvider, GenerateInput } from './types'

/**
 * The OpenAI-compatible implementation of §5.6 — the same code path serves OpenAI, a local
 * llama.cpp server, Ollama, or anything else that speaks `/v1/chat/completions`, selected by
 * `OPENAI_BASE_URL`.
 *
 * `maxRetries: 0` is the §7 rule that a provider 429 is surfaced, never retried.
 */

const MAX_OUTPUT_TOKENS = 16_000

/**
 * Exported for the S7 seam and for tests; the client is otherwise created per generation.
 *
 * A base URL other than the operator's `OPENAI_BASE_URL` came from a user's key, so that client
 * never follows a redirect (see `fetchWithoutRedirects`). The operator's own endpoint, and the
 * SDK default, keep the SDK's ordinary behaviour. `fetchImpl` is injected by tests.
 */
export function createOpenAiClient(
  apiKey: string,
  baseUrl: string | undefined,
  fetchImpl?: FetchLike,
): OpenAI {
  const userSupplied = baseUrl !== undefined && baseUrl !== env.OPENAI_BASE_URL
  return userSupplied
    ? new OpenAI({
        apiKey,
        baseURL: baseUrl,
        maxRetries: 0,
        fetch: fetchWithoutRedirects(fetchImpl),
      })
    : new OpenAI({ apiKey, baseURL: baseUrl ?? null, maxRetries: 0 })
}

/**
 * Unlike Anthropic, this wire format can signal a refusal before any content: `delta.refusal`
 * carries the model's own words, which §7 says to show the user verbatim.
 */
async function* streamOpenAiCompatible(input: GenerateInput): AsyncGenerator<string> {
  const client = createOpenAiClient(input.apiKey, input.baseUrl)
  let tokensIn: number | null = null
  let tokensOut: number | null = null

  try {
    const stream = await client.chat.completions.create(
      {
        model: input.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: ARTIFACT_SYSTEM_PROMPT },
          { role: 'user', content: input.prompt },
        ],
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: input.signal },
    )

    for await (const chunk of stream) {
      if (chunk.usage != null) {
        tokensIn = chunk.usage.prompt_tokens
        tokensOut = chunk.usage.completion_tokens
      }

      const choice = chunk.choices[0]
      if (choice === undefined) continue
      if (choice.delta.refusal != null) throw providerRefusal(choice.delta.refusal)
      if (choice.finish_reason === 'content_filter') throw providerRefusal('')

      const text = choice.delta.content
      if (text != null && text !== '') yield text
    }
  } catch (error) {
    if (input.signal.aborted) throw error
    throw toProviderError(error)
  } finally {
    // Reported from `finally` so a throw or a consumer `return()` still accounts for the
    // tokens the provider already charged for.
    input.onUsage?.({ tokensIn, tokensOut })
  }
}

export const openAiCompatibleProvider: ArtifactProvider = {
  id: 'openai-compatible',
  generate: streamOpenAiCompatible,
}
