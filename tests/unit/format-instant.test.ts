import { afterEach, describe, expect, it } from 'vitest'

import {
  formatDayLocal,
  formatDayStable,
  formatInstantLocal,
  formatInstantStable,
} from '@/lib/format/instant'

const WIRE_INSTANT = '2026-08-10T00:00:00.000Z'
const ORIGINAL_TZ = process.env.TZ

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

describe('formatInstantStable (first paint, before mount)', () => {
  it('renders the wire instant unchanged', () => {
    expect(formatInstantStable(WIRE_INSTANT)).toBe(WIRE_INSTANT)
  })

  it('is identical no matter which zone the rendering host is in', () => {
    for (const zone of ['UTC', 'Asia/Jakarta', 'America/New_York']) {
      process.env.TZ = zone
      expect(formatInstantStable(WIRE_INSTANT)).toBe(WIRE_INSTANT)
    }
  })

  it('proves the defect this replaces: the old bare toLocaleString() DID depend on the host zone', () => {
    const rendered = new Set<string>()
    for (const zone of ['UTC', 'Asia/Jakarta', 'America/New_York']) {
      process.env.TZ = zone
      rendered.add(new Date(WIRE_INSTANT).toLocaleString())
    }
    // Three different zones produced three different strings for the exact same instant — that
    // divergence, between the Node host at SSR time and the browser after hydration, is the React
    // text mismatch this task fixes. formatInstantStable never varies (asserted above).
    expect(rendered.size).toBe(3)
  })

  it('falls back to the empty label for null, and to a custom label when given one', () => {
    expect(formatInstantStable(null)).toBe('—')
    expect(formatInstantStable(null, 'never')).toBe('never')
  })

  it('falls back to the empty label for an unparseable instant, never throwing', () => {
    expect(formatInstantStable('not-a-date', 'never')).toBe('never')
    expect(formatInstantStable('')).toBe('—')
  })
})

describe('formatInstantLocal (after mount: the viewer\'s own zone)', () => {
  it('renders in the given zone with an explicit zone label', () => {
    expect(formatInstantLocal(WIRE_INSTANT, '—', 'UTC')).toBe('10 Aug 2026, 00:00 UTC')
    expect(formatInstantLocal(WIRE_INSTANT, '—', 'Asia/Jakarta')).toBe('10 Aug 2026, 07:00 GMT+7')
    expect(formatInstantLocal(WIRE_INSTANT, '—', 'America/New_York')).toBe(
      '09 Aug 2026, 20:00 GMT-4',
    )
  })

  it('differs across zones for the same instant — this is the fix, not a bug', () => {
    const jakarta = formatInstantLocal(WIRE_INSTANT, '—', 'Asia/Jakarta')
    const newYork = formatInstantLocal(WIRE_INSTANT, '—', 'America/New_York')
    const utc = formatInstantLocal(WIRE_INSTANT, '—', 'UTC')
    expect(new Set([jakarta, newYork, utc]).size).toBe(3)
  })

  it('falls back to the empty label for null and for an unparseable instant', () => {
    expect(formatInstantLocal(null, 'never', 'UTC')).toBe('never')
    expect(formatInstantLocal('not-a-date', 'never', 'UTC')).toBe('never')
  })
})

describe('formatDayStable (first paint, before mount)', () => {
  it('renders the wire instant\'s date portion unchanged', () => {
    expect(formatDayStable(WIRE_INSTANT)).toBe('2026-08-10')
  })

  it('is identical no matter which zone the rendering host is in', () => {
    for (const zone of ['UTC', 'Asia/Jakarta', 'America/New_York']) {
      process.env.TZ = zone
      expect(formatDayStable(WIRE_INSTANT)).toBe('2026-08-10')
    }
  })

  it('falls back to the raw string for an unparseable instant, never throwing', () => {
    expect(formatDayStable('not-a-date')).toBe('not-a-date')
  })
})

describe('formatDayLocal (after mount: the viewer\'s own zone)', () => {
  it('renders in the given zone with an explicit zone label', () => {
    expect(formatDayLocal(WIRE_INSTANT, 'UTC')).toBe('10 Aug 2026, UTC')
    expect(formatDayLocal(WIRE_INSTANT, 'Asia/Jakarta')).toBe('10 Aug 2026, GMT+7')
    expect(formatDayLocal(WIRE_INSTANT, 'America/New_York')).toBe('09 Aug 2026, GMT-4')
  })

  it('shows a different calendar day west of UTC — the exact defect being fixed', () => {
    expect(formatDayLocal(WIRE_INSTANT, 'America/New_York').startsWith('09 Aug')).toBe(true)
    expect(formatDayLocal(WIRE_INSTANT, 'UTC').startsWith('10 Aug')).toBe(true)
  })

  it('falls back to the raw string for an unparseable instant, never throwing', () => {
    expect(formatDayLocal('not-a-date', 'UTC')).toBe('not-a-date')
  })
})
