import { formatBytes } from '@/lib/format/bytes'
import type { StreamedFile } from './use-generation'

/**
 * Pure helpers behind the composer's stream panel, kept out of the component so they can be
 * tested without a DOM (`@testing-library/react` is not installed for this repo).
 */

/** How close to the end counts as "following the stream". About two lines of the file body. */
export const NEAR_BOTTOM_PX = 48

export interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/**
 * The stream only sticks to the bottom while the reader is already there. Someone who scrolled up
 * to read an earlier file keeps their place; scrolling back down re-engages the follow.
 */
export function isNearBottom(metrics: ScrollMetrics, threshold: number = NEAR_BOTTOM_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
}

/**
 * The text of the composer's polite live region: the most recently finished file, or '' before
 * any has. Derived from state rather than pushed from an effect — a live region speaks whenever its
 * text changes, and every `file_end` changes which file is last-finished, so each one is announced
 * once. Files finish in stream order (the server writes one file at a time), so "last finished in
 * array order" is "most recently finished".
 */
export function fileDoneAnnouncement(files: readonly StreamedFile[]): string {
  // A reverse scan rather than `findLast`, which the configured TS lib does not include.
  const finished = [...files].reverse().find((file) => file.bytes !== null)
  if (finished === undefined) return ''
  return `${finished.path} written, ${formatBytes(finished.bytes ?? 0)}`
}

/** ⌘+Enter on macOS, Ctrl+Enter elsewhere; both are accepted everywhere so nobody has to guess. */
export function isSubmitShortcut(event: {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly isComposing?: boolean
}): boolean {
  // An IME composition uses Enter to commit the candidate, not to submit.
  if (event.isComposing === true) return false
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
}
