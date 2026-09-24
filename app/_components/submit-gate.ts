/**
 * The latch behind `SubmitButton`: the first submit of a form goes through, every later one is
 * refused until the page is shown again. Kept free of React and the DOM so the rule is testable in
 * the node unit project.
 *
 * `reopen` exists for the back/forward cache: a page restored with `pageshow.persisted` keeps its
 * JavaScript state, so without it a user who pressed Back after signing in would find the button
 * still locked.
 */
export interface SubmitGate {
  /** True when this submit may proceed; false when one is already under way. */
  readonly tryEnter: () => boolean
  readonly reopen: () => void
  readonly isLocked: () => boolean
}

export function createSubmitGate(): SubmitGate {
  let locked = false
  return {
    tryEnter() {
      if (locked) return false
      locked = true
      return true
    },
    reopen() {
      locked = false
    },
    isLocked: () => locked,
  }
}
