'use client'

import { useSyncExternalStore } from 'react'

/**
 * Every deadline is stored as an absolute instant and judged on the database clock
 * (src/lib/shares/clock.ts:4-6), but *display* depends on who is looking, and the server cannot
 * know the viewer's zone. Rendering a zoned string during SSR (or in the first client render,
 * before hydration) is exactly the defect this module fixes: a bare `toLocaleString()` renders in
 * the Node host's zone at first paint and the viewer's zone once React hydrates — a text mismatch
 * that, west of UTC, shows a different calendar day.
 *
 * The fix is not a fixed display zone (that only relocates the mismatch) — it is to never disagree
 * with yourself. `formatInstantStable`/`formatDayStable` render the wire instant unchanged, so
 * first paint is identical on every host and every viewer; `useIsMountedForLocalTime` flips true
 * after the first client commit, at which point callers swap to `formatInstantLocal`/
 * `formatDayLocal`, which render in the viewer's own zone with an explicit zone label.
 */

function buildInstantFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  })
}

function buildDayFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZoneName: 'short',
  })
}

// Every real call site omits `timeZone` (it wants the viewer's own zone), so that is the shape
// worth caching — constructing one per row is the slow path on the admin/users and invites
// tables. Only tests pass an explicit zone, to stay independent of the machine running them.
const DEFAULT_INSTANT_FORMAT = buildInstantFormat(undefined)
const DEFAULT_DAY_FORMAT = buildDayFormat(undefined)

function subscribeToNothing(): () => void {
  // The mounted/hydrated flag never changes again once true, so there is nothing to subscribe to.
  return () => {}
}

/**
 * True once React has hydrated. The server/client snapshot split avoids the mismatch a
 * `useState`+`useEffect` pair would flag under `set-state-in-effect`. Call once per component,
 * never inside `.map()`.
 */
export function useIsMountedForLocalTime(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  )
}

/** First paint, before mount: the wire instant itself, unchanged — identical on every host. */
export function formatInstantStable(iso: string | null, emptyLabel = '—'): string {
  if (iso === null) return emptyLabel
  return Number.isNaN(Date.parse(iso)) ? emptyLabel : iso
}

/** After mount: the viewer's own zone, with an explicit zone label. `timeZone` is test-only. */
export function formatInstantLocal(
  iso: string | null,
  emptyLabel = '—',
  timeZone?: string,
): string {
  if (iso === null) return emptyLabel
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return emptyLabel
  const formatter = timeZone === undefined ? DEFAULT_INSTANT_FORMAT : buildInstantFormat(timeZone)
  return formatter.format(new Date(parsed))
}

/** First paint, before mount: the wire instant's date portion, unchanged. */
export function formatDayStable(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : iso.slice(0, 10)
}

/** After mount: the viewer's own zone, day granularity, with an explicit zone label. */
export function formatDayLocal(iso: string, timeZone?: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return iso
  const formatter = timeZone === undefined ? DEFAULT_DAY_FORMAT : buildDayFormat(timeZone)
  return formatter.format(new Date(parsed))
}
