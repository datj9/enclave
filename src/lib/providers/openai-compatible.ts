import OpenAI from 'openai'

import { ARTIFACT_SYSTEM_PROMPT } from '@/prompts/system'
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

/** Exported for the S7 seam and for tests; the client is otherwise created per generation. */
export function createOpenAiClient(apiKey: string, baseUrl: string | undefined): OpenAI {
  return new OpenAI({ apiKey, baseURL: baseUrl ?? null, maxRetries: 0 })
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
  }

  input.onUsage?.({ tokensIn, tokensOut })
}

export const openAiCompatibleProvider: ArtifactProvider = {
  id: 'openai-compatible',
  generate: streamOpenAiCompatible,
}
