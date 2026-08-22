import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Spec: auto-categorize §no-instance-key. A default install (or an admin who enabled the setting
 * before adding a key) has no instance provider key; classification must read as "no tags" without
 * a warning, a provider call, or a `selectProvider` exception that the catch would log.
 */

const selectProvider = vi.fn()
const collectCompletion = vi.fn()
const applyModelTags = vi.fn()
const getAutoCategorizeEnabled = vi.fn()
const listCategories = vi.fn()

vi.mock('@/env', () => ({
  env: {
    ANTHROPIC_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    DEFAULT_MODEL: 'claude-sonnet-4-6',
  },
}))

vi.mock('@/lib/settings/instance-settings', () => ({
  getAutoCategorizeEnabled: () => getAutoCategorizeEnabled(),
}))

vi.mock('@/lib/categories/manage', () => ({
  listCategories: () => listCategories(),
}))

vi.mock('@/lib/providers', () => ({ selectProvider }))

vi.mock('@/lib/generation/collect', () => ({ collectCompletion }))

vi.mock('@/lib/artifacts/tags', () => ({ applyModelTags }))

vi.mock('@/lib/categories/classify-prompt', () => ({
  buildClassifyPrompt: () => '',
  CLASSIFY_TIMEOUT_MS: 1,
  extractEntryText: () => '',
  parseClassifyReply: () => [],
}))

const { classifyArtifactVersion } = await import('@/lib/categories/classify')

describe('classifyArtifactVersion with no instance key', () => {
  beforeEach(() => {
    selectProvider.mockReset()
    collectCompletion.mockReset()
    applyModelTags.mockReset()
    getAutoCategorizeEnabled.mockReset()
    listCategories.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('returns without selecting a provider, calling the model, or warning', async () => {
    getAutoCategorizeEnabled.mockResolvedValue(true)
    listCategories.mockResolvedValue([
      {
        id: 'id-docs',
        name: 'Docs',
        slug: 'docs',
        description: null,
        isActive: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])

    await classifyArtifactVersion({
      artifactId: '00000000-0000-0000-0000-000000000000',
      title: 'No key artifact',
      files: [],
    })

    expect(selectProvider).not.toHaveBeenCalled()
    expect(collectCompletion).not.toHaveBeenCalled()
    expect(applyModelTags).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
