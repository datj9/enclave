'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { deleteConfirmBody } from '@/lib/artifacts/delete-copy'
import { cx } from '@/lib/ui/class-name'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import styles from './delete-dialog.module.css'
import { useOwnerControls } from './owner-controls'

/**
 * The owner's delete control (US-10). Deleting kills every share link at the same instant, which
 * is the part a confirmation has to say out loud — the author reaches for delete precisely when a
 * link went somewhere it should not have.
 *
 * The modal itself is the shared ConfirmDialog; this file owns the request and the trigger. The
 * live-link count comes from the page's owner controls, which the Share dialog keeps current, so a
 * link revoked there is already out of this sentence without a second read. Its motion rule — the
 * destructive buttons get no animation at all — is in dialog.module.css for the confirm button
 * and in delete-dialog.module.css for the trigger.
 */

const DELETE_FAILED = 'That artifact could not be deleted.'

export function DeleteDialog({
  artifactId,
  retentionDays,
}: {
  readonly artifactId: string
  readonly retentionDays: number
}) {
  const router = useRouter()
  const { liveCount: liveShareCount } = useOwnerControls()
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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
      trigger={{
        label: 'Delete',
        className: cx('button-sm', styles.trigger),
        testId: 'delete-open',
      }}
      title="Delete this artifact?"
      body={deleteConfirmBody(liveShareCount, retentionDays)}
      confirmLabel={isBusy ? 'Deleting…' : 'Delete'}
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
