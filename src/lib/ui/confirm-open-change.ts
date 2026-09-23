/** The slice of base-ui's `Dialog.Root` change details this guard needs. */
export interface CancelableOpenChange {
  cancel(): void
}

/**
 * ConfirmDialog's `onOpenChange` gate. While the caller's request is in flight, every close request
 * — Esc, a backdrop press, the cancel button — is canceled: closing then would either hide the
 * failure the request is about to report, or let the action land after the person "cancelled".
 *
 * `cancel()` is what keeps an uncontrolled dialog open (base-ui skips its own state update);
 * not forwarding to `onOpenChange` is what keeps a controlled one open. Opening always passes, and
 * so does a close the caller makes itself by flipping `open`, which never comes through here.
 */
export function guardOpenChange(
  isOpen: boolean,
  details: CancelableOpenChange,
  busy: boolean,
  onOpenChange: ((open: boolean) => void) | undefined,
): void {
  if (busy && !isOpen) {
    details.cancel()
    return
  }
  onOpenChange?.(isOpen)
}
