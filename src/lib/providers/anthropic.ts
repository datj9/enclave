import Anthropic from '@anthropic-ai/sdk'

import { ARTIFACT_SYSTEM_PROMPT } from '@/prompts/system'
import { providerRefusal, toProviderError } from './errors'
import type { ArtifactProvider, GenerateInput } from './types'

/**
 * The Anthropic implementation of §5.6. Yields text deltas only; the `<file>` parser above decides
 * what they mean.
 *
 * `maxRetries: 0` is the §7 rule that a provider 429 is surfaced, never retried.
 */

const MAX_OUTPUT_TOKENS = 16_000

/** Exported for the S7 seam and for tests; the client is otherwise created per generation. */
export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, maxRetries: 0 })
}

/**
 * A refusal is only distinguishable from ordinary prose when the API says so. Anthropic reports it
 * on the closing `message_delta`, so a model that refuses in words has already been rejected as
 * `MALFORMED_MODEL_OUTPUT` by the parser — same outcome for the user, nothing persisted either way.
 */
async function* streamAnthropic(input: GenerateInput): AsyncGenerator<string> {
  const client = createAnthropicClient(input.apiKey)
  let tokensIn: number | null = null
  let tokensOut: number | null = null

  try {
    const stream = await client.messages.create(
      {
        model: input.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: ARTIFACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: input.prompt }],
        stream: true,
      },
      { signal: input.signal },
    )

    for await (const event of stream) {
      if (event.type === 'message_start') {
        tokensIn = event.message.usage.input_tokens
      }
      if (event.type === 'message_delta') {
        tokensOut = event.usage.output_tokens
        if (event.delta.stop_reason === 'refusal') throw providerRefusal('')
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text
      }
    }
  } catch (error) {
    if (input.signal.aborted) throw error
    throw toProviderError(error)
  }

  input.onUsage?.({ tokensIn, tokensOut })
}

export const anthropicProvider: ArtifactProvider = {
  id: 'anthropic',
  generate: streamAnthropic,
}
