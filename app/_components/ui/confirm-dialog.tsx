'use client'

import { Dialog } from '@base-ui/react/dialog'
import { useRef, type ReactNode, type RefObject } from 'react'

import { guardOpenChange } from '@/lib/ui/confirm-open-change'
import styles from './dialog.module.css'

/**
 * The one "are you sure?" modal: a title, a sentence that says what will happen, one button that
 * commits and one that backs out. Every confirmation in the app renders through this so they share
 * a frame, a motion, a focus contract and an error slot.
 *
 * It is deliberately dumb about the work. The caller owns the request, the `busy` flag and the
 * error text, and decides whether the dialog closes after `onConfirm` — which is what lets one
 * confirmation close on success, another stay open on failure, and a third never close itself.
 *
 * Open state is controlled (`open` + `onOpenChange`) or left to base-ui when a `trigger` is given
 * and `open` is not. The two combine: a controlled dialog can still render its own trigger.
 */

export type ConfirmTone = 'default' | 'danger'

export interface ConfirmDialogTrigger {
  /** The trigger button's content. */
  readonly label: ReactNode
  readonly className?: string | undefined
  readonly testId?: string | undefined
}

export interface ConfirmDialogProps {
  /** Heading; also the dialog's accessible name. */
  readonly title: ReactNode
  /** What confirming does, in full. Rendered as the dialog's accessible description. */
  readonly body: ReactNode
  /** Text of the committing button. Name the action ("Delete account"), never "OK". */
  readonly confirmLabel: ReactNode
  /** Text of the button that closes without acting. Defaults to "Cancel". */
  readonly cancelLabel?: ReactNode | undefined
  /**
   * `danger` for an irreversible or destructive action. Both tones currently look the same (see
   * dialog.module.css); the value is exposed as `data-tone` on the confirm button.
   */
  readonly tone?: ConfirmTone | undefined
  /**
   * The caller's request is in flight. Both buttons go `aria-disabled` — they keep focus, unlike
   * `disabled` — `onConfirm` is not called again, and Esc, a backdrop press and the cancel button
   * do not close the dialog until it clears. The caller can still close it by setting `open`.
   */
  readonly busy?: boolean | undefined
  /** A failure to show inside the dialog, announced as an alert. `null`/omitted shows nothing. */
  readonly error?: string | null | undefined
  /** Called when the confirm button is pressed while not `busy`. Does not close the dialog. */
  readonly onConfirm: () => void

  /** Controlled open state. Omit to let base-ui track it (needs `trigger`). */
  readonly open?: boolean | undefined
  /**
   * Every open/close request — trigger press, Esc, backdrop click, the cancel button. Close
   * requests made while `busy` are dropped rather than forwarded.
   */
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  /** Renders a `Dialog.Trigger` button that opens the dialog. */
  readonly trigger?: ConfirmDialogTrigger | undefined

  /**
   * Which button takes focus on open. Omitted keeps base-ui's default: the first tabbable
   * element — the confirm button — or the popup itself when opened by touch. Pass `'cancel'`
   * when a stray Enter must not commit.
   */
  readonly initialFocus?: 'confirm' | 'cancel' | undefined
  /** Where focus lands on close. Omitted returns it to the trigger / previously focused element. */
  readonly finalFocus?: RefObject<HTMLElement | null> | undefined

  /** `data-testid` on the popup. */
  readonly testId?: string | undefined
  /** `data-testid` on the confirm button. */
  readonly confirmTestId?: string | undefined
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  busy = false,
  error = null,
  onConfirm,
  open,
  onOpenChange,
  trigger,
  initialFocus,
  finalFocus,
  testId,
  confirmTestId,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  const initialFocusRef =
    initialFocus === 'cancel' ? cancelRef : initialFocus === 'confirm' ? confirmRef : undefined

  return (
    <Dialog.Root
      // Spread rather than `open={open}` so an omitted prop leaves the dialog uncontrolled.
      {...(open === undefined ? {} : { open })}
      onOpenChange={(isOpen, details) => guardOpenChange(isOpen, details, busy, onOpenChange)}
    >
      {trigger !== undefined && (
        <Dialog.Trigger className={trigger.className} data-testid={trigger.testId}>
          {trigger.label}
        </Dialog.Trigger>
      )}

      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup
          className={styles.popup}
          initialFocus={initialFocusRef}
          finalFocus={finalFocus}
          data-testid={testId}
        >
          <Dialog.Title className={styles.title}>{title}</Dialog.Title>
          <Dialog.Description className={styles.description}>{body}</Dialog.Description>

          {error !== null && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className={styles.actions}>
            <button
              ref={confirmRef}
              className={styles.confirm}
              type="button"
              aria-disabled={busy}
              data-tone={tone}
              data-testid={confirmTestId}
              onClick={() => {
                if (!busy) onConfirm()
              }}
            >
              {confirmLabel}
            </button>
            <Dialog.Close ref={cancelRef} className={styles.cancel} aria-disabled={busy}>
              {cancelLabel}
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
