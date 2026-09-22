import { describe, expect, it } from 'vitest'

import { formatBytes } from '@/lib/format/bytes'

describe('formatBytes', () => {
  it('prints whole bytes below one kibibyte', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('switches to KB at 1024 with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('switches to MB at one mebibyte rather than printing thousands of KB', () => {
    expect(formatBytes(1024 * 1023)).toBe('1023.0 KB')
    // Rounds to 1024.0 KB, so it is promoted rather than printed as a four-digit KB figure.
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatBytes(10.25 * 1024 * 1024)).toBe('10.3 MB')
  })

  it('clamps nonsense input to zero instead of printing NaN', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('rounds fractional byte counts', () => {
    expect(formatBytes(10.6)).toBe('11 B')
  })
})
