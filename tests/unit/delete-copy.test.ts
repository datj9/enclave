import { describe, expect, it } from 'vitest'

import { deleteConfirmBody } from '@/lib/artifacts/delete-copy'

/**
 * The delete confirmation names a number of live links, so the sentence has to agree with itself on
 * link/links, stops/stop and it/them — and has to say nothing about links at all when none are live.
 */

describe('deleteConfirmBody', () => {
  it('says the artifact has no live links when none are live', () => {
    expect(deleteConfirmBody(0, 30)).toBe(
      'It leaves your list and stops opening for everyone, you included. It has no live share links. You have 30 days to restore it from the trash before it is erased for good.',
    )
  })

  it('names one link in the singular, with the singular verb and pronoun', () => {
    expect(deleteConfirmBody(1, 30)).toBe(
      'It leaves your list and stops opening for everyone, you included. Its 1 live share link stops working immediately, and restoring does not bring it back. You have 30 days to restore it from the trash before it is erased for good.',
    )
  })

  it('names several links in the plural, with the plural verb and pronoun', () => {
    expect(deleteConfirmBody(2, 30)).toBe(
      'It leaves your list and stops opening for everyone, you included. Its 2 live share links stop working immediately, and restoring does not bring them back. You have 30 days to restore it from the trash before it is erased for good.',
    )
  })

  it('keeps the exact count rather than rounding it to "some"', () => {
    expect(deleteConfirmBody(17, 30)).toContain('Its 17 live share links stop working')
  })

  it('names the retention window it was given', () => {
    expect(deleteConfirmBody(0, 7)).toContain('You have 7 days to restore it')
  })

  /** A count can only arrive from Postgres, but a negative one must not read as a warning. */
  it('falls back to the no-links sentence for a count below zero', () => {
    expect(deleteConfirmBody(-1, 30)).toContain('It has no live share links.')
  })
})
