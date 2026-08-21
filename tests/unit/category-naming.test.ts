import { describe, expect, it } from 'vitest'

import { slugFromCategoryName } from '@/lib/categories/naming'

/**
 * Spec: categories-taxonomy §`slugFromCategoryName` (src/lib/categories/naming.ts).
 * Lowercase → replace runs outside [a-z0-9] with a single `-` → strip leading/trailing `-`;
 * `null` when the result is empty. All tests are [must-fail] at RED: the module does not exist.
 */
describe('slugFromCategoryName', () => {
  it('slugFromCategoryName lowercases and joins words with a single dash', () => {
    expect(slugFromCategoryName('Data Dashboards')).toBe('data-dashboards')
    expect(slugFromCategoryName('docs')).toBe('docs')
  })

  it('slugFromCategoryName strips characters outside the slug alphabet', () => {
    expect(slugFromCategoryName('Reports & Analysis!')).toBe('reports-analysis')
  })

  it('slugFromCategoryName collapses dash runs and trims the ends', () => {
    expect(slugFromCategoryName('A///B')).toBe('a-b')
    expect(slugFromCategoryName('  Docs  ')).toBe('docs')
  })

  it('slugFromCategoryName returns null when nothing slug-able remains', () => {
    expect(slugFromCategoryName('!!!')).toBeNull()
    expect(slugFromCategoryName('')).toBeNull()
  })
})