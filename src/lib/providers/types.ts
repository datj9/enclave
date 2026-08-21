/**
 * The provider port from grill-result §5.6, decision #12. Both implementations emit raw text
 * deltas and nothing else, which is what keeps the `<file>` parser above them provider-agnostic
 * and testable with no network.
 *
 * Deliberately free of any SDK import: the `generations` table and the parser tests both depend
 * on this module, and neither should pull a vendor client into its bundle.
 */

export const PROVIDER_IDS = ['anthropic', 'anthropic-compatible', 'openai-compatible'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** Providers whose endpoint the user chooses, and so may set a base URL for. */
export const BASE_URL_PROVIDER_IDS = ['anthropic-compatible', 'openai-compatible'] as const
export type BaseUrlProviderId = (typeof BASE_URL_PROVIDER_IDS)[number]

export function acceptsBaseUrl(provider: ProviderId): provider is BaseUrlProviderId {
  return (BASE_URL_PROVIDER_IDS as readonly ProviderId[]).includes(provider)
}

export interface ProviderUsage {
  readonly tokensIn: number | null
  readonly tokensOut: number | null
}

export interface GenerateInput {
  readonly prompt: string
  readonly model: string
  readonly apiKey: string
  readonly baseUrl?: string
  readonly signal: AbortSignal
  /**
   * Additive to the §5.6 signature. §5.2 requires `tokens_in` / `tokens_out` on the generations
   * row, and deltas are strings, so usage needs its own channel. Called at most once, after the
   * last delta.
   */
  readonly onUsage?: (usage: ProviderUsage) => void
}

export interface ArtifactProvider {
  readonly id: ProviderId
  generate(input: GenerateInput): AsyncIterable<string>
}
