'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { deleteConfirmBody } from '@/lib/artifacts/delete-copy'
import { cx } from '@/lib/ui/class-name'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import styles from './delete-dialog.module.css'

/**
 * The owner's delete control (US-10). Deleting kills every share link at the same instant, which
 * is the part a confirmation has to say out loud — the author reaches for delete precisely when a
 * link went somewhere it should not have.
 *
 * The modal itself is the shared ConfirmDialog; this file owns the request, the live-link count and
 * the trigger. Its motion rule — the destructive buttons get no animation at all — is in
 * dialog.module.css for the confirm button and in delete-dialog.module.css for the trigger.
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
    <ConfirmDialog
      onOpenChange={(isOpen) => {
        if (isOpen) void refreshLiveShareCount()
      }}
      trigger={{
        label: 'Delete',
        className: cx('button-sm', styles.trigger),
        testId: 'delete-open',
      }}
      title="Delete this artifact?"
      body={deleteConfirmBody(liveShareCount, retentionDays)}
      confirmLabel="Delete"
      cancelLabel="Keep it"
      tone="danger"
      busy={isBusy}
      error={errorMessage}
      testId="delete-dialog"
      confirmTestId="delete-confirm"
      onConfirm={() => void handleDelete()}
    />
  )
}
