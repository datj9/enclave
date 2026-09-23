import { describe, expect, it } from 'vitest'

import { radioFocusTarget } from '@app/a/[id]/radio-keys'

/**
 * The privacy switch moved from automatic to manual activation: arrows only move focus, so a
 * keyboard user walking from Only me to Organization never passes through a write on the way.
 * What commits is the button's own click (Space/Enter), which this function must leave alone.
 */

const COUNT = 3

describe('radioFocusTarget', () => {
  it('moves forward on ArrowRight and ArrowDown', () => {
    expect(radioFocusTarget('ArrowRight', 0, COUNT)).toBe(1)
    expect(radioFocusTarget('ArrowDown', 1, COUNT)).toBe(2)
  })

  it('moves back on ArrowLeft and ArrowUp', () => {
    expect(radioFocusTarget('ArrowLeft', 2, COUNT)).toBe(1)
    expect(radioFocusTarget('ArrowUp', 1, COUNT)).toBe(0)
  })

  it('wraps at both ends', () => {
    expect(radioFocusTarget('ArrowRight', 2, COUNT)).toBe(0)
    expect(radioFocusTarget('ArrowLeft', 0, COUNT)).toBe(2)
  })

  it('jumps to the ends on Home and End', () => {
    expect(radioFocusTarget('Home', 2, COUNT)).toBe(0)
    expect(radioFocusTarget('End', 0, COUNT)).toBe(2)
  })

  it('ignores Space and Enter so the native button click is what commits', () => {
    expect(radioFocusTarget(' ', 1, COUNT)).toBeNull()
    expect(radioFocusTarget('Enter', 1, COUNT)).toBeNull()
  })

  it('ignores Tab and ordinary characters', () => {
    expect(radioFocusTarget('Tab', 1, COUNT)).toBeNull()
    expect(radioFocusTarget('a', 1, COUNT)).toBeNull()
  })

  it('starts from the first option when the focused index is outside the group', () => {
    expect(radioFocusTarget('ArrowRight', -1, COUNT)).toBe(1)
    expect(radioFocusTarget('ArrowLeft', 7, COUNT)).toBe(2)
  })

  it('returns null for an empty group rather than dividing by zero', () => {
    expect(radioFocusTarget('ArrowRight', 0, 0)).toBeNull()
    expect(radioFocusTarget('Home', 0, 0)).toBeNull()
  })
})
