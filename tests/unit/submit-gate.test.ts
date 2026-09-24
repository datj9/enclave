import { describe, expect, it } from 'vitest'

import { createSubmitGate } from '@app/_components/submit-gate'

describe('createSubmitGate', () => {
  it('lets the first submit through and refuses the next', () => {
    const gate = createSubmitGate()

    expect(gate.isLocked()).toBe(false)
    expect(gate.tryEnter()).toBe(true)
    expect(gate.isLocked()).toBe(true)
    expect(gate.tryEnter()).toBe(false)
    expect(gate.tryEnter()).toBe(false)
  })

  it('reopens when the page is restored from the back/forward cache', () => {
    const gate = createSubmitGate()
    gate.tryEnter()

    gate.reopen()

    expect(gate.isLocked()).toBe(false)
    expect(gate.tryEnter()).toBe(true)
  })

  it('keeps separate gates independent', () => {
    const first = createSubmitGate()
    const second = createSubmitGate()

    first.tryEnter()

    expect(second.tryEnter()).toBe(true)
  })
})
