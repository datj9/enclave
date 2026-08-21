import type { ProviderSelection } from '@/lib/providers'

/**
 * Drains a streaming provider response into one string. Never throws — a timeout, a provider
 * error or an empty reply all read as `null` so the caller can treat a failed classification
 * as "no tags".
 */
export async function collectCompletion(
  selection: ProviderSelection,
  prompt: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let joined = ''
    for await (const chunk of selection.provider.generate({
      prompt,
      model: selection.model,
      apiKey: selection.apiKey,
      signal: controller.signal,
      ...(selection.baseUrl === undefined ? {} : { baseUrl: selection.baseUrl }),
    })) {
      joined += chunk
    }
    return joined.trim() === '' ? null : joined
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}