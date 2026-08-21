import { describe, expect, it } from 'vitest'

import { parseClassifyReply } from '@/lib/categories/classify-prompt'
import type { CategoryView } from '@/lib/categories/manage'

/**
 * Spec: auto-categorize §`parseClassifyReply` against the worked examples. Pure, so no database
 * and no provider. All tests are [must-fail] at RED: the `src/lib/categories/classify-prompt.ts`
 * module does not exist yet.
 */

const CATEGORIES: readonly CategoryView[] = [
  {
    id: 'id-docs',
    name: 'Docs',
    slug: 'docs',
    description: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'id-api',
    name: 'API',
    slug: 'api',
    description: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
]

describe('parseClassifyReply', () => {
  it('parseClassifyReply maps known slugs to category ids in reply order', () => {
    expect(parseClassifyReply('["docs"]', CATEGORIES)).toEqual(['id-docs'])
    expect(parseClassifyReply('["docs","api"]', CATEGORIES)).toEqual(['id-docs', 'id-api'])
  })

  it('parseClassifyReply reads a fenced json block', () => {
    expect(parseClassifyReply('```json\n["docs"]\n```', CATEGORIES)).toEqual(['id-docs'])
  })

  it('parseClassifyReply reads an array embedded in prose', () => {
    expect(parseClassifyReply('Here you go: ["api"] — hope that helps', CATEGORIES)).toEqual([
      'id-api',
    ])
  })

  it('parseClassifyReply matches slugs case-insensitively', () => {
    expect(parseClassifyReply('["DOCS"]', CATEGORIES)).toEqual(['id-docs'])
  })

  it('parseClassifyReply de-duplicates repeated slugs', () => {
    expect(parseClassifyReply('["docs","docs"]', CATEGORIES)).toEqual(['id-docs'])
  })

  it('parseClassifyReply drops slugs that are not in the list', () => {
    expect(parseClassifyReply('["nope"]', CATEGORIES)).toEqual([])
    expect(parseClassifyReply('["docs","api","nope","docs"]', CATEGORIES)).toEqual([
      'id-docs',
      'id-api',
    ])
  })

  it('parseClassifyReply truncates to three ids', () => {
    const four = [
      { id: 'id-a', name: 'A', slug: 'a', description: null, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'id-b', name: 'B', slug: 'b', description: null, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'id-c', name: 'C', slug: 'c', description: null, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'id-d', name: 'D', slug: 'd', description: null, isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
    ]

    expect(parseClassifyReply('["a","b","c","d"]', four)).toEqual(['id-a', 'id-b', 'id-c'])
  })

  it('parseClassifyReply returns nothing for malformed json', () => {
    expect(parseClassifyReply('not json at all', CATEGORIES)).toEqual([])
  })

  it('parseClassifyReply returns nothing for a json object', () => {
    expect(parseClassifyReply('{"slug":"docs"}', CATEGORIES)).toEqual([])
  })

  it('parseClassifyReply returns nothing for an array of numbers', () => {
    expect(parseClassifyReply('[1,2]', CATEGORIES)).toEqual([])
  })
})
