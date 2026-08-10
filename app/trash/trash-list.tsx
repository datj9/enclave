'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import type { TrashedArtifact } from '@/lib/artifacts/trash'
import { formatDayLocal, formatDayStable, useIsMountedForLocalTime } from '@/lib/format/instant'
import styles from './trash-list.module.css'

/**
 * Restore is the only action here — a trashed artifact cannot be opened, so there is nothing to
 * link to. `router.refresh()` re-reads the list on the server rather than splicing the row out
 * locally, which keeps the days-remaining counts honest.
 */

const RESTORE_FAILED = 'That artifact could not be restored. Its restore window may have run out.'

function daysLabel(daysRemaining: number): string {
  if (daysRemaining === 0) return 'erased on the next purge'
  return `${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'} left`
}

export function TrashList({ items }: { readonly items: readonly TrashedArtifact[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  async function restore(artifactId: string): Promise<void> {
    if (busyId !== null) return
    setBusyId(artifactId)
    setErrorMessage(null)

    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}/restore`, { method: 'POST' })
      if (!response.ok) {
        setErrorMessage(RESTORE_FAILED)
        return
      }
      router.refresh()
    } catch {
      setErrorMessage(RESTORE_FAILED)
    } finally {
      setBusyId(null)
    }
  }

  if (items.length === 0) {
    return (
      <p className={styles.empty} data-testid="trash-empty">
        Nothing in the trash.
      </p>
    )
  }

  return (
    <>
      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      <ul className={styles.list} data-testid="trash-list">
        {items.map((item) => (
          <li className={styles.row} key={item.id} data-testid="trash-row" data-artifact={item.id}>
            <div>
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
              onClick={() => void restore(item.id)}
            >
              Restore
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
