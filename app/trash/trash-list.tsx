'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { TrashedArtifact } from '@/lib/artifacts/trash'
import { formatDayLocal, formatDayStable, useIsMountedForLocalTime } from '@/lib/format/instant'
import styles from './trash-list.module.css'

/**
 * Restore is the only action here — a trashed artifact cannot be opened, so a row has nothing to
 * link to. `router.refresh()` re-reads the list on the server rather than splicing the row out
 * locally, which keeps the days-remaining counts honest.
 *
 * The refresh removes the restored row, so the confirmation — with the link to the now-live
 * artifact — is held in local state and rendered outside the list, where it survives the refresh
 * (and the list emptying). It lives in a permanently-mounted `status` region so it is announced.
 */

interface RestoredArtifact {
  readonly id: string
  readonly title: string
}

const RESTORE_FAILED = 'That artifact could not be restored. Its restore window may have run out.'

function daysLabel(daysRemaining: number): string {
  if (daysRemaining === 0) return 'erased on the next purge'
  return `${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'} left`
}

export function TrashList({ items }: { readonly items: readonly TrashedArtifact[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [restored, setRestored] = useState<RestoredArtifact | null>(null)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  async function restore(item: TrashedArtifact): Promise<void> {
    if (busyId !== null) return
    setBusyId(item.id)
    setErrorMessage(null)
    setRestored(null)

    try {
      const response = await fetch(`/api/v1/artifacts/${item.id}/restore`, { method: 'POST' })
      if (!response.ok) {
        setErrorMessage(RESTORE_FAILED)
        return
      }
      setRestored({ id: item.id, title: item.title })
      router.refresh()
    } catch {
      setErrorMessage(RESTORE_FAILED)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <p className={styles.restored} role="status" data-testid="trash-restored">
        {restored !== null && (
          <>
            Restored <span className={styles.restoredTitle}>{restored.title}</span>.{' '}
            <Link href={`/a/${restored.id}`} data-testid="trash-restored-link">
              Open it
            </Link>
          </>
        )}
      </p>

      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      {items.length === 0 ? (
        <p className={styles.empty} data-testid="trash-empty">
          Nothing in the trash.
        </p>
      ) : (
        <TrashRows
          items={items}
          busyId={busyId}
          isMountedForLocalTime={isMountedForLocalTime}
          onRestore={(item) => void restore(item)}
        />
      )}
    </>
  )
}

function TrashRows({
  items,
  busyId,
  isMountedForLocalTime,
  onRestore,
}: {
  readonly items: readonly TrashedArtifact[]
  readonly busyId: string | null
  readonly isMountedForLocalTime: boolean
  readonly onRestore: (item: TrashedArtifact) => void
}) {
  return (
    <ul className={styles.list} data-testid="trash-list">
      {items.map((item) => (
        <li className={styles.row} key={item.id} data-testid="trash-row" data-artifact={item.id}>
          <div className={styles.rowText}>
            <p className={styles.rowName}>{item.title}</p>
            <p className={styles.rowMeta}>
              Deleted{' '}
              {isMountedForLocalTime
                ? formatDayLocal(item.deletedAt)
                : formatDayStable(item.deletedAt)}{' '}
              ·{' '}
              <span className="tabular" data-testid="trash-days">
                {daysLabel(item.daysRemaining)}
              </span>
            </p>
          </div>
          <button
            className="button-secondary"
            type="button"
            aria-disabled={busyId !== null}
            data-testid="trash-restore"
            onClick={() => onRestore(item)}
          >
            {busyId === item.id ? 'Restoring' : 'Restore'}
          </button>
        </li>
      ))}
    </ul>
  )
}
