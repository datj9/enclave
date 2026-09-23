import { describe, expect, it, vi } from 'vitest'

import { guardOpenChange } from '@/lib/ui/confirm-open-change'

/**
 * ConfirmDialog must not close mid-request: a failure would render into a dialog nobody sees, and
 * a success would land after the person pressed Cancel.
 */

describe('guardOpenChange', () => {
  it('cancels a close request while busy and does not tell the caller', () => {
    const cancel = vi.fn()
    const onOpenChange = vi.fn()
    guardOpenChange(false, { cancel }, true, onOpenChange)
    expect(cancel).toHaveBeenCalledOnce()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('forwards a close request when idle', () => {
    const cancel = vi.fn()
    const onOpenChange = vi.fn()
    guardOpenChange(false, { cancel }, false, onOpenChange)
    expect(cancel).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('forwards an open request even while busy', () => {
    const cancel = vi.fn()
    const onOpenChange = vi.fn()
    guardOpenChange(true, { cancel }, true, onOpenChange)
    expect(cancel).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  it('still cancels while busy when the dialog is uncontrolled and has no handler', () => {
    const cancel = vi.fn()
    guardOpenChange(false, { cancel }, true, undefined)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
