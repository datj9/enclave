import { env } from '@/env'
import type { BundleFile } from '@/lib/bundle/validate'
import { listCategories } from '@/lib/categories/manage'
import {
  buildClassifyPrompt,
  CLASSIFY_TIMEOUT_MS,
  extractEntryText,
  parseClassifyReply,
} from '@/lib/categories/classify-prompt'
import { collectCompletion } from '@/lib/generation/collect'
import { selectProvider } from '@/lib/providers'
import { getAutoCategorizeEnabled } from '@/lib/settings/instance-settings'
import { applyModelTags } from '@/lib/artifacts/tags'

/**
 * Best-effort classification of a new artifact version against the admin's taxonomy.
 *
 * The instance provider key pays for the call and the instance quota is never touched — the
 * caller did not ask for this. Every gate below is cheapest-first and returns before any
 * provider call, and every failure path warns and returns. This function never throws, so the
 * upload hooks call it bare.
 *
 * Returns whether tags were written: every gate and every failure reads as `false`.
 */
export async function classifyArtifactVersion(input: {
  readonly artifactId: string
  readonly title: string
  readonly files: readonly BundleFile[]
}): Promise<boolean> {
  try {
    if (!(await getAutoCategorizeEnabled())) return false

    const categories = await listCategories({ includeInactive: false })
    if (categories.length === 0) return false

    // Instance keys only — `userKeys` is always `{}`. A missing key is a supported
    // configuration (default install, or admin enabled the setting before adding a
    // key), not an error: return silently so every upload does not warn.
    if (env.ANTHROPIC_API_KEY === undefined && env.OPENAI_API_KEY === undefined) return false

    const selection = selectProvider({
      instanceAnthropicKey: env.ANTHROPIC_API_KEY,
      instanceOpenAiKey: env.OPENAI_API_KEY,
      openAiBaseUrl: env.OPENAI_BASE_URL,
      model: env.DEFAULT_MODEL,
      userKeys: {},
    })

    const prompt = buildClassifyPrompt({
      title: input.title,
      entryText: extractEntryText(input.files),
      categories,
    })
    const reply = await collectCompletion(selection, prompt, CLASSIFY_TIMEOUT_MS)
    if (reply === null) return false

    const parsed = parseClassifyReply(reply, categories)
    if (parsed === null) return false

    return await applyModelTags(input.artifactId, parsed)
  } catch (error) {
    console.warn(`[auto-categorize] classification failed for artifact ${input.artifactId}:`, error)
    return false
  }
}
