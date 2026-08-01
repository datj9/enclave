'use client'

import { Dialog } from '@base-ui-components/react/dialog'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import styles from './delete-dialog.module.css'

/**
 * The owner's delete control (US-10). Deleting kills every share link at the same instant, which
 * is the part a confirmation has to say out loud — the author reaches for delete precisely when a
 * link went somewhere it should not have.
 *
 * Motion is docs/motion.md § This project's surfaces: the popup scales in like the share dialog,
 * and the destructive button gets nothing at all. An instant response is what reads as trustworthy.
 */

const DELETE_FAILED = 'That artifact could not be deleted.'

/** A CSS-module class types as `string | undefined`; base-ui's `className` prop refuses that. */
function css(className: string | undefined): string {
  return className ?? ''
}

export function DeleteDialog({
  artifactId,
  activeShareCount,
  retentionDays,
}: {
  readonly artifactId: string
  readonly activeShareCount: number
  readonly retentionDays: number
}) {
  const router = useRouter()
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleDelete(): Promise<void> {
    setIsBusy(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}`, { method: 'DELETE' })
      if (!response.ok) {
        setErrorMessage(DELETE_FAILED)
        return
      }
      // The artifact page 404s for the owner from here on, so staying put would show an error.
      router.push('/trash')
    } catch {
      setErrorMessage(DELETE_FAILED)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <Dialog.Root>
      <Dialog.Trigger className={css(styles.trigger)} data-testid="delete-open">
        Delete
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className={css(styles.backdrop)} />
        <Dialog.Popup className={css(styles.popup)} data-testid="delete-dialog">
          <Dialog.Title className={css(styles.title)}>Delete this artifact?</Dialog.Title>
          <Dialog.Description className={css(styles.description)}>
            It leaves your list and stops opening for everyone, you included.{' '}
            {activeShareCount === 0
              ? 'It has no live share links.'
              : `Its ${activeShareCount} live share ${activeShareCount === 1 ? 'link' : 'links'} stop working immediately, and restoring does not bring ${activeShareCount === 1 ? 'it' : 'them'} back.`}{' '}
            You have {retentionDays} days to restore it from the trash before it is erased for good.
          </Dialog.Description>

          {errorMessage !== null && (
            <p className="form-error" role="alert">
              {errorMessage}
            </p>
          )}

          <div className={styles.actions}>
            <button
              className={styles.confirm}
              type="button"
              disabled={isBusy}
              data-testid="delete-confirm"
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
            <Dialog.Close className={css(styles.cancel)}>Keep it</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
