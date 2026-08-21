import { describe, expect, it } from 'vitest'

import { parseUpdateArtifactBody } from '@/lib/artifacts/update'

/**
 * Spec: artifact-tagging §`parseUpdateArtifactBody` — extended. The `categoryIds` field is added
 * to `updateArtifactBodySchema` (kept `.strict()`), so a body carrying only `categoryIds` becomes
 * valid while the existing `title` / `visibility` behaviour must not change. All tests are
 * [must-fail] at RED except 3 and 6 ([pin]: they characterise behaviour that already passes).
 */

function parse(body: unknown) {
  return parseUpdateArtifactBody(body)
}

describe('parseUpdateArtifactBody', () => {
  it('parseUpdateArtifactBody accepts a body carrying only categoryIds', () => {
    expect(parse({ categoryIds: ['7f3e0000-0000-4000-8000-000000000001'] })).toEqual({
      ok: true,
      value: { categoryIds: ['7f3e0000-0000-4000-8000-000000000001'] },
    })
  })

  it('parseUpdateArtifactBody accepts an empty categoryIds array', () => {
    expect(parse({ categoryIds: [] })).toEqual({ ok: true, value: { categoryIds: [] } })
  })

  it('parseUpdateArtifactBody still rejects an empty body naming the root', () => {
    const result = parse({})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.details.fields as string[] | undefined) ?? []).toContain('(root)')
    }
  })

  it('parseUpdateArtifactBody rejects a categoryIds entry that is not a uuid', () => {
    const result = parse({ categoryIds: ['not-a-uuid'] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.details.fields as string[] | undefined) ?? []).toContain('categoryIds.0')
    }
  })

  it('parseUpdateArtifactBody rejects an unknown field alongside categoryIds', () => {
    const result = parse({ categoryIds: [], colour: 'red' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect((result.details.fields as string[] | undefined) ?? []).toContain('colour')
    }
  })

  it('parseUpdateArtifactBody still accepts a title on its own', () => {
    expect(parse({ title: 'New' })).toEqual({ ok: true, value: { title: 'New' } })
  })
})
