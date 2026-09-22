import { describe, expect, it } from 'vitest'

import { cx } from '@/lib/ui/class-name'

/**
 * `cx` replaced `clsx` and two copy-pasted `css()` shims. What it has to guarantee is that a
 * missing CSS-module key or a false condition never reaches the DOM as literal text.
 */

describe('cx', () => {
  it('joins every non-empty string with a single space', () => {
    expect(cx('button-sm', 'confirm')).toBe('button-sm confirm')
  })

  it('drops undefined, a missing CSS-module key, rather than printing "undefined"', () => {
    const styles: Record<string, string | undefined> = { popup: 'popup_x1' }
    expect(cx(styles['popup'], styles['missing'])).toBe('popup_x1')
  })

  it('drops false and null so conditional classes read as `isWide && styles.wide`', () => {
    const isWide = false
    expect(cx('popup', isWide && 'wide', null)).toBe('popup')
  })

  it('drops empty strings instead of leaving double spaces', () => {
    expect(cx('', 'a', '', 'b')).toBe('a b')
  })

  it('returns an empty string when nothing survives, which every className prop accepts', () => {
    expect(cx()).toBe('')
    expect(cx(undefined, false)).toBe('')
  })
})
