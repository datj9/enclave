import { describe, expect, it } from 'vitest'

import { privateConfirmBody, privateHint } from '@/lib/artifacts/privacy-copy'

/**
 * Issue #25: the `Only me` copy has to be true for the number of links that actually exist. A zero
 * count must say nothing about links at all, and every other count has to agree with itself on
 * link/links, opens/open and it/them.
 */

describe('privateHint', () => {
  it('says nothing about links when none are live', () => {
    expect(privateHint(0)).toBe('Nobody can browse to it.')
  })

  it('names one link in the singular, with the singular pronoun', () => {
    expect(privateHint(1)).toBe(
      'Nobody can browse to it. 1 share link still opens it — revoke it in Share.',
    )
  })

  it('names several links in the plural, with the plural pronoun', () => {
    expect(privateHint(2)).toBe(
      'Nobody can browse to it. 2 share links still open it — revoke them in Share.',
    )
  })

  it('keeps the exact count rather than rounding it to "some"', () => {
    expect(privateHint(17)).toContain('17 share links')
  })

  /** A count can only arrive from Postgres, but a negative one must not read as a warning. */
  it('falls back to the bare sentence for a count below zero', () => {
    expect(privateHint(-1)).toBe('Nobody can browse to it.')
  })
})

describe('privateConfirmBody', () => {
  it('warns about one link in the singular', () => {
    expect(privateConfirmBody(1)).toBe(
      '1 share link still opens this artifact. Setting it to Only me does not close it — revoke it in Share.',
    )
  })

  it('warns about several links in the plural', () => {
    expect(privateConfirmBody(2)).toBe(
      '2 share links still open this artifact. Setting it to Only me does not close them — revoke them in Share.',
    )
  })

  it('never claims the downgrade closes the links', () => {
    expect(privateConfirmBody(3)).toContain('does not close them')
  })
})
