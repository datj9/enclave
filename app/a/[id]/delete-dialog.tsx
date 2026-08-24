'use client'

import { Dialog } from '@base-ui-components/react/dialog'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { deleteConfirmBody } from '@/lib/artifacts/delete-copy'
import { css } from '@/lib/ui/class-name'
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

interface ShareListResponse {
  readonly data: { readonly liveCount: number }
}

export function DeleteDialog({
  artifactId,
  initialLiveShareCount,
  retentionDays,
}: {
  readonly artifactId: string
  readonly initialLiveShareCount: number
  readonly retentionDays: number
}) {
  const router = useRouter()
  const [liveShareCount, setLiveShareCount] = useState(initialLiveShareCount)
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // The count check is a round trip; reopening before it lands would fire a second one.
  const isCountingShareLinks = useRef(false)

  /**
   * The Share dialog sits on this same page and can revoke a link without a reload, so the number
   * the server rendered may already be wrong. A failed read falls back to it rather than to zero —
   * a warning that was true at page load beats claiming there is nothing to lose.
   */
  async function readLiveShareCount(): Promise<number> {
    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}/shares`)
      if (!response.ok) return liveShareCount
      return ((await response.json()) as ShareListResponse).data.liveCount
    } catch {
      return liveShareCount
    }
  }

  async function refreshLiveShareCount(): Promise<void> {
    if (isCountingShareLinks.current) return
    isCountingShareLinks.current = true

    try {
      setLiveShareCount(await readLiveShareCount())
    } finally {
      isCountingShareLinks.current = false
    }
  }

  async function handleDelete(): Promise<void> {
    if (isBusy) return
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
    <Dialog.Root
      onOpenChange={(isOpen) => {
        if (isOpen) void refreshLiveShareCount()
      }}
    >
      <Dialog.Trigger className={`button-sm ${css(styles.trigger)}`} data-testid="delete-open">
        Delete
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className={css(styles.backdrop)} />
        <Dialog.Popup className={css(styles.popup)} data-testid="delete-dialog">
          <Dialog.Title className={css(styles.title)}>Delete this artifact?</Dialog.Title>
          <Dialog.Description className={css(styles.description)}>
            {deleteConfirmBody(liveShareCount, retentionDays)}
          </Dialog.Description>

          {errorMessage !== null && (
            <p className="form-error" role="alert">
              {errorMessage}
            </p>
          )}

          <div className={styles.actions}>
            <button
              className={`button-sm ${styles.confirm}`}
              type="button"
              aria-disabled={isBusy}
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
