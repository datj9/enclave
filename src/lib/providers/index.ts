import { env } from '@/env'
import { HttpError } from '@/lib/http'
import { anthropicCompatibleProvider, anthropicProvider } from './anthropic'
import { openAiCompatibleProvider } from './openai-compatible'
import type { ArtifactProvider, ProviderId } from './types'

export { acceptsBaseUrl, BASE_URL_PROVIDER_IDS, PROVIDER_IDS } from './types'
export type { ArtifactProvider, BaseUrlProviderId, GenerateInput, ProviderId, ProviderUsage } from './types'

/**
 * Which provider runs, and with whose key. Decision #10: `userKey ?? instanceKey`, per provider.
 *
 * Anthropic wins when both are configured — it is the reference implementation for the §5.5 format
 * and the one the system prompt is tuned against. `anthropic-compatible` has no instance-key
 * fallback: it exists so a user can point at their own gateway, never the instance's.
 */

const NO_KEY_MESSAGE =
  'No model provider is configured. Add an instance API key, or your own in settings.'

/** A user's own credential for one provider. */
export interface UserProviderCredential {
  readonly apiKey: string
  readonly baseUrl: string | undefined
}

/** Per-user keys, decrypted by the caller — see `loadUserProviderKeys` in ./user-keys. */
export type UserProviderKeys = Readonly<Partial<Record<ProviderId, UserProviderCredential>>>

export interface ProviderCredentials {
  readonly instanceAnthropicKey: string | undefined
  readonly instanceOpenAiKey: string | undefined
  readonly openAiBaseUrl: string | undefined
  readonly model: string
  readonly userKeys: UserProviderKeys
}

export interface ProviderSelection {
  readonly provider: ArtifactProvider
  readonly apiKey: string
  readonly model: string
  readonly baseUrl: string | undefined
  /** Written to `generations.used_instance_key`; S7's quota is larger when a user brings a key. */
  readonly usedInstanceKey: boolean
}

/** Pure — the whole point of the split, so key precedence is testable without an environment. */
export function selectProvider(credentials: ProviderCredentials): ProviderSelection {
  const anthropicKey = credentials.userKeys.anthropic?.apiKey ?? credentials.instanceAnthropicKey
  if (anthropicKey !== undefined) {
    return {
      provider: anthropicProvider,
      apiKey: anthropicKey,
      model: credentials.model,
      baseUrl: undefined,
      usedInstanceKey: credentials.userKeys.anthropic === undefined,
    }
  }

  const anthropicCompatible = credentials.userKeys['anthropic-compatible']
  if (anthropicCompatible !== undefined) {
    return {
      provider: anthropicCompatibleProvider,
      apiKey: anthropicCompatible.apiKey,
      model: credentials.model,
      baseUrl: anthropicCompatible.baseUrl,
      usedInstanceKey: false,
    }
  }

  const openAiCredential = credentials.userKeys['openai-compatible']
  const openAiKey = openAiCredential?.apiKey ?? credentials.instanceOpenAiKey
  if (openAiKey !== undefined) {
    return {
      provider: openAiCompatibleProvider,
      apiKey: openAiKey,
      model: credentials.model,
      baseUrl: openAiCredential !== undefined ? openAiCredential.baseUrl : credentials.openAiBaseUrl,
      usedInstanceKey: openAiCredential === undefined,
    }
  }

  throw new HttpError('PROVIDER_KEY_INVALID', NO_KEY_MESSAGE)
}

/**
 * Instance keys from the environment, the caller's own keys from `user_provider_keys` — the
 * caller decrypts those with `loadUserProviderKeys` and passes them in. An empty map means the
 * user has none stored, which is also what marks the selection as running on the instance key.
 */
export function resolveProviderForUser(userKeys: UserProviderKeys = {}): ProviderSelection {
  return selectProvider({
    instanceAnthropicKey: env.ANTHROPIC_API_KEY,
    instanceOpenAiKey: env.OPENAI_API_KEY,
    openAiBaseUrl: env.OPENAI_BASE_URL,
    model: env.DEFAULT_MODEL,
    userKeys,
  })
}
