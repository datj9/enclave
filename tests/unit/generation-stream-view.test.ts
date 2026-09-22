import { describe, expect, it } from 'vitest'

import {
  NEAR_BOTTOM_PX,
  fileDoneAnnouncement,
  isNearBottom,
  isSubmitShortcut,
} from '@app/new/stream-view'
import type { StreamedFile } from '@app/new/use-generation'

describe('isNearBottom', () => {
  const viewport = { scrollHeight: 1000, clientHeight: 400 }

  it('is true at the very bottom', () => {
    expect(isNearBottom({ ...viewport, scrollTop: 600 })).toBe(true)
  })

  it('is true within the threshold of the bottom', () => {
    expect(isNearBottom({ ...viewport, scrollTop: 600 - NEAR_BOTTOM_PX })).toBe(true)
  })

  it('is false once the reader has scrolled further up than the threshold', () => {
    expect(isNearBottom({ ...viewport, scrollTop: 600 - NEAR_BOTTOM_PX - 1 })).toBe(false)
    expect(isNearBottom({ ...viewport, scrollTop: 0 })).toBe(false)
  })

  it('is true when the content does not overflow at all', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true)
  })

  it('honours a custom threshold', () => {
    expect(isNearBottom({ ...viewport, scrollTop: 590 }, 5)).toBe(false)
    expect(isNearBottom({ ...viewport, scrollTop: 596 }, 5)).toBe(true)
  })
})

describe('fileDoneAnnouncement', () => {
  const writing = (path: string): StreamedFile => ({ path, text: '', bytes: null })
  const done = (path: string, bytes: number): StreamedFile => ({ path, text: '', bytes })

  it('is empty before any file has finished', () => {
    expect(fileDoneAnnouncement([])).toBe('')
    expect(fileDoneAnnouncement([writing('index.html')])).toBe('')
  })

  it('names the most recently finished file and its size', () => {
    expect(fileDoneAnnouncement([done('index.html', 2048), writing('app.js')])).toBe(
      'index.html written, 2.0 KB',
    )
    expect(fileDoneAnnouncement([done('index.html', 2048), done('app.js', 12)])).toBe(
      'app.js written, 12 B',
    )
  })

  it('changes text on every file_end, which is what makes the live region speak', () => {
    const first = fileDoneAnnouncement([done('a.js', 1), writing('b.js')])
    const second = fileDoneAnnouncement([done('a.js', 1), done('b.js', 1)])
    expect(first).not.toBe(second)
  })
})

describe('isSubmitShortcut', () => {
  const key = (overrides: Partial<Parameters<typeof isSubmitShortcut>[0]>) => ({
    key: 'Enter',
    metaKey: false,
    ctrlKey: false,
    ...overrides,
  })

  it('accepts Cmd+Enter and Ctrl+Enter', () => {
    expect(isSubmitShortcut(key({ metaKey: true }))).toBe(true)
    expect(isSubmitShortcut(key({ ctrlKey: true }))).toBe(true)
  })

  it('leaves a plain Enter to insert a newline', () => {
    expect(isSubmitShortcut(key({}))).toBe(false)
  })

  it('ignores other keys with a modifier', () => {
    expect(isSubmitShortcut(key({ key: 'a', metaKey: true }))).toBe(false)
  })

  it('ignores Enter while an IME composition is open', () => {
    expect(isSubmitShortcut(key({ metaKey: true, isComposing: true }))).toBe(false)
  })
})
