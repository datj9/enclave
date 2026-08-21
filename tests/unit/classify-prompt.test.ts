import { describe, expect, it } from 'vitest'

import { buildClassifyPrompt, extractEntryText, MAX_ENTRY_TEXT_LENGTH } from '@/lib/categories/classify-prompt'
import type { CategoryView } from '@/lib/categories/manage'

/**
 * Spec: auto-categorize §`extractEntryText` and §`buildClassifyPrompt` — both are pure, so these
 * unit tests need no database and no provider. All tests are [must-fail] at RED: the
 * `src/lib/categories/classify-prompt.ts` module does not exist yet.
 */

function entryFile(html: string): { readonly path: string; readonly content: Buffer } {
  return { path: 'index.html', content: Buffer.from(html, 'utf8') }
}

function category(overrides: Partial<CategoryView> = {}): CategoryView {
  return {
    id: 'id-docs',
    name: 'Docs',
    slug: 'docs',
    description: 'The documentation category',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('extractEntryText', () => {
  it('extractEntryText returns the visible text of the entry file', () => {
    expect(extractEntryText([entryFile('<h1>Hello</h1>')])).toBe('Hello')
  })

  it('extractEntryText drops script contents', () => {
    expect(extractEntryText([entryFile('<script>var x=1</script><p>Body</p>')])).toBe('Body')
  })

  it('extractEntryText drops style contents', () => {
    expect(extractEntryText([entryFile('<style>.a{color:red}</style><p>Body</p>')])).toBe('Body')
  })

  it('extractEntryText collapses whitespace runs to single spaces', () => {
    expect(extractEntryText([entryFile('<p>a</p>\n\n   <p>b</p>')])).toBe('a b')
  })

  it('extractEntryText returns an empty string when there is no entry file', () => {
    expect(extractEntryText([{ path: 'other.html', content: Buffer.from('<p>Body</p>', 'utf8') }])).toBe('')
  })

  it('extractEntryText truncates to the maximum entry length', () => {
    const html = `<p>${'a'.repeat(9000)}</p>`
    const text = extractEntryText([entryFile(html)])

    expect(text).toHaveLength(MAX_ENTRY_TEXT_LENGTH)
    expect(text).toBe('a'.repeat(MAX_ENTRY_TEXT_LENGTH))
  })
})

describe('buildClassifyPrompt', () => {
  it('buildClassifyPrompt names the title and every category slug', () => {
    const prompt = buildClassifyPrompt({
      title: 'Report',
      entryText: 'Some visible text',
      categories: [category()],
    })

    expect(prompt).toContain('Report')
    expect(prompt).toContain('docs')
  })

  it('buildClassifyPrompt falls back to the category name when the description is null', () => {
    const prompt = buildClassifyPrompt({
      title: 'Report',
      entryText: 'Some visible text',
      categories: [category({ description: null, name: 'Docs' })],
    })

    expect(prompt).toContain('Docs')
  })

  it('buildClassifyPrompt caps the category list at the prompt maximum', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      category({ id: `id-${index}`, name: `Category ${index}`, slug: `slug-${index}` }),
    )

    const prompt = buildClassifyPrompt({ title: 'Report', entryText: 'Text', categories: many })

    expect(prompt).toContain('slug-49')
    expect(prompt).not.toContain('slug-50')
  })
})
