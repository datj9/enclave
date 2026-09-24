/**
 * Keyboard model for the privacy radiogroup: WAI-ARIA APG radio group with *manual* activation.
 *
 * The arrow keys only move focus. Committing a level is a network write — and for `public` a
 * confirmation — so it must never happen as a side effect of walking past an option on the way to
 * another one. Space (and Enter, since each radio is a `<button>`) commits the focused option
 * through the button's native click, which is why neither key is handled here.
 *
 * Kept pure so the wrap-around and the keys it ignores are unit-testable without a DOM.
 */

const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

/**
 * The index focus should move to for `key`, or `null` when the key does not move focus (the
 * caller then leaves the event alone, so Space, Enter and Tab keep their native behaviour).
 *
 * Arrows wrap at both ends; Home and End jump to the first and last option.
 */
export function radioFocusTarget(key: string, focusedIndex: number, count: number): number | null {
  if (count < 1) return null
  if (key === 'Home') return 0
  if (key === 'End') return count - 1

  const step = ARROW_STEPS[key]
  if (step === undefined) return null
  // An index outside the group (nothing inside it focused) starts from the first option.
  const from = focusedIndex >= 0 && focusedIndex < count ? focusedIndex : 0
  return (from + step + count) % count
}
