import { describe, expect, it } from 'vitest'

import { DEFAULT_LIST_LIMIT, parseListQuery } from '@/lib/artifacts/list-query'

/**
 * Spec: artifact-tagging §`parseListQuery` — extended. `?category=<slug>` is parsed into
 * `categorySlug` (trimmed; empty or whitespace-only becomes `undefined`; anything failing
 * `/^[a-z0-9-]{1,80}$/` is rejected with `fields: ['category']`), while the existing `limit`
 * and `cursor` parsing must not change. All tests are [must-fail] at RED except 11 ([pin]: it
 * characterises behaviour that already passes).
 */

function query(search: string) {
  return parseListQuery(new URLSearchParams(search))
}

describe('parseListQuery', () => {
  it('parseListQuery reads a category slug', () => {
    expect(query('category=docs')).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIST_LIMIT, cursor: undefined, categorySlug: 'docs' },
    })
  })

  it('parseListQuery treats an empty category as no filter', () => {
    expect(query('')).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIST_LIMIT, cursor: undefined, categorySlug: undefined },
    })
    expect(query('category=')).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIST_LIMIT, cursor: undefined, categorySlug: undefined },
    })
  })

  it('parseListQuery rejects a category slug with uppercase characters', () => {
    const result = query('category=Docs')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.details.fields as string[] | undefined) ?? []).toContain('category')
    }
  })

  it('parseListQuery rejects a category slug containing a space', () => {
    const result = query('category=a b')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.details.fields as string[] | undefined) ?? []).toContain('category')
    }
  })

  it('parseListQuery still reads limit and cursor unchanged', () => {
    expect(query('limit=5&category=docs')).toEqual({
      ok: true,
      value: { limit: 5, cursor: undefined, categorySlug: 'docs' },
    })
  })
})
