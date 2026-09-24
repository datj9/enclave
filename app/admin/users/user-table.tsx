'use client'

import { useRef, useState } from 'react'

import type { AdminUserSummary } from '@/lib/admin/users'
import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { cx } from '@/lib/ui/class-name'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import styles from '../admin.module.css'
import deleteStyles from './delete-user-dialog.module.css'
import {
  accessActionFor,
  needsConfirmation,
  roleActionFor,
  userActionConfirmation,
  userActionRequest,
  type ConfirmedUserAction,
  type UserAction,
} from './user-actions'

/**
 * Dense table, no row animation (docs/motion.md): rows that move while an operator reads them are
 * unreadable. State changes swap text and buttons in place.
 *
 * Artifact columns are counts only. There is no route behind this table that could return a title.
 *
 * Every action except Reactivate confirms first (user-actions.ts), through one ConfirmDialog for
 * the whole table. A refusal keeps that dialog open with the server's reason inside it, where the
 * operator is looking — not behind the popup, above a table they cannot see.
 */

interface ListResponse {
  readonly data: { readonly items: readonly AdminUserSummary[] }
}

interface ErrorResponse {
  readonly error: { readonly message: string; readonly details?: Record<string, unknown> }
}

const GENERIC_FAILURE = 'That did not work. Reload and try again.'

async function failureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorResponse
    const blocking = body.error.details?.['blockingArtifactIds']
    if (Array.isArray(blocking)) {
      return `${body.error.message} (${blocking.length} artifact(s): ${blocking.join(', ')})`
    }
    return body.error.message
  } catch {
    return GENERIC_FAILURE
  }
}

interface PendingAction {
  readonly person: AdminUserSummary
  readonly action: ConfirmedUserAction
}

/** Which row's request is in flight, and for what — the busy label goes on that one button. */
interface BusyAction {
  readonly personId: string
  readonly action: UserAction
}

export function UserTable({
  initialUsers,
  currentUserId,
}: {
  readonly initialUsers: readonly AdminUserSummary[]
  readonly currentUserId: string
}) {
  const [people, setPeople] = useState(initialUsers)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<BusyAction | null>(null)
  // Kept after close so the dialog does not change its wording during its exit transition.
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [isConfirmOpen, setIsConfirmOpen] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  /**
   * Where focus goes when the confirmation closes. `null` returns it to the button that opened it,
   * which every action but Delete leaves in place. A deleted row takes that button with it, so
   * focus goes to a neighbouring row instead (deleteFocusTarget).
   */
  const confirmFinalFocus = useRef<HTMLElement | null>(null)
  const tableRef = useRef<HTMLTableElement | null>(null)
  const isMountedForLocalTime = useIsMountedForLocalTime()
  const isBusy = busy !== null

  function formatMoment(iso: string | null): string {
    return isMountedForLocalTime ? formatInstantLocal(iso) : formatInstantStable(iso)
  }

  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/api/v1/users')
      if (!response.ok) return
      setPeople(((await response.json()) as ListResponse).data.items)
    } catch {
      // The write already landed; the table catches up on the next action or reload.
    }
  }

  /** Resolves to the failure text, or `null` when the action succeeded. Never rejects. */
  async function run(person: AdminUserSummary, action: UserAction): Promise<string | null> {
    const { path, init } = userActionRequest(action, person)
    setBusy({ personId: person.id, action })
    try {
      const response = await fetch(path, init)
      if (!response.ok) return await failureMessage(response)
      await refresh()
      return null
    } catch {
      return GENERIC_FAILURE
    } finally {
      setBusy(null)
    }
  }

  function requestAction(person: AdminUserSummary, action: UserAction): void {
    // `aria-disabled` keeps focus but still fires; every row action funnels through here.
    if (isBusy) return
    if (needsConfirmation(action)) {
      setConfirmError(null)
      confirmFinalFocus.current = null
      setPending({ person, action })
      setIsConfirmOpen(true)
      return
    }
    setErrorMessage(null)
    void run(person, action).then(setErrorMessage)
  }

  async function confirmPending(): Promise<void> {
    if (pending === null || isBusy) return
    setConfirmError(null)
    const { person, action } = pending
    // Chosen before the request, while the row is certainly still rendered: the re-read inside
    // run() may already have removed it by the time the request resolves.
    const deleteFocus = action === 'delete' ? deleteFocusTarget(tableRef.current, person.id) : null
    const failure = await run(person, action)
    if (failure !== null) {
      setConfirmError(failure)
      return
    }
    if (action === 'delete') {
      confirmFinalFocus.current = deleteFocus
      // Also removed here, so the row is gone even if the re-read failed.
      setPeople((current) => current.filter((row) => row.id !== person.id))
    }
    setIsConfirmOpen(false)
  }

  const confirmation =
    pending === null ? null : userActionConfirmation(pending.action, pending.person)
  const isConfirmBusy =
    pending !== null && busy?.personId === pending.person.id && busy.action === pending.action

  return (
    <>
      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className={styles.tableScroll}>
        {/* tabIndex -1: focus lands here after a delete when no other row is left to take it. */}
        <table className={styles.table} ref={tableRef} tabIndex={-1} aria-label="Accounts">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Access</th>
              <th className={styles.numeric} scope="col">
                Artifacts
              </th>
              <th className={styles.numeric} scope="col">
                Shared
              </th>
              <th scope="col">Joined</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              // tabIndex -1: not in the tab order, but a place for focus to land after a delete
              // when this row has no action button of its own (your own row).
              <tr key={person.id} data-user-id={person.id} tabIndex={-1}>
                <td>{person.email}</td>
                <td>{person.role}</td>
                <td>
                  {person.isActive ? 'active' : `deactivated ${formatMoment(person.deactivatedAt)}`}
                </td>
                <td className={styles.numeric}>{person.liveArtifactCount}</td>
                <td className={styles.numeric}>{person.sharedArtifactCount}</td>
                <td>{formatMoment(person.createdAt)}</td>
                <td>
                  {person.id === currentUserId ? (
                    <span className={styles.muted}>you</span>
                  ) : (
                    <RowActions
                      person={person}
                      isBusy={isBusy}
                      isReactivating={busy?.personId === person.id && busy.action === 'reactivate'}
                      onAction={requestAction}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={isConfirmOpen}
        onOpenChange={setIsConfirmOpen}
        title={confirmation?.title ?? ''}
        body={confirmation?.body ?? ''}
        confirmLabel={
          isConfirmBusy ? (confirmation?.busyLabel ?? '') : (confirmation?.confirmLabel ?? '')
        }
        tone={confirmation?.tone}
        busy={isBusy}
        error={confirmError}
        finalFocus={confirmFinalFocus}
        testId={pending === null ? undefined : `user-${pending.action}-dialog`}
        confirmTestId={pending === null ? undefined : `user-${pending.action}-confirm`}
        onConfirm={() => void confirmPending()}
      />
    </>
  )
}

/**
 * Where focus goes once the row for `personId` is deleted: the next row's first action, else the
 * previous row's, else that neighbouring row itself (your own row has no actions), else the table.
 * Read from the DOM before the row is removed, so the neighbours are still next to it.
 */
function deleteFocusTarget(table: HTMLTableElement | null, personId: string): HTMLElement | null {
  if (table === null) return null
  const row = Array.from(table.tBodies[0]?.rows ?? []).find(
    (candidate) => candidate.dataset['userId'] === personId,
  )
  const neighbour = row?.nextElementSibling ?? row?.previousElementSibling ?? null
  if (neighbour instanceof HTMLTableRowElement) {
    return neighbour.querySelector<HTMLElement>('button') ?? neighbour
  }
  return table
}

function RowActions({
  person,
  isBusy,
  isReactivating,
  onAction,
}: {
  readonly person: AdminUserSummary
  readonly isBusy: boolean
  readonly isReactivating: boolean
  readonly onAction: (person: AdminUserSummary, action: UserAction) => void
}) {
  const accessAction = accessActionFor(person)
  const roleAction = roleActionFor(person)

  return (
    <div className={styles.rowActions}>
      <button
        className="button-secondary button-sm"
        type="button"
        aria-disabled={isBusy}
        data-testid={`user-${accessAction}`}
        onClick={() => onAction(person, accessAction)}
      >
        {accessAction === 'deactivate'
          ? 'Deactivate'
          : isReactivating
            ? 'Reactivating…'
            : 'Reactivate'}
      </button>
      <button
        className="button-secondary button-sm"
        type="button"
        aria-disabled={isBusy}
        data-testid={`user-${roleAction}`}
        onClick={() => onAction(person, roleAction)}
      >
        {roleAction === 'make-member' ? 'Make member' : 'Make admin'}
      </button>
      {/*
        The server refuses to delete an account that still owns artifacts, so the only case that
        reaches the API is the newly-invited person who has not published yet — irreversible, with
        nothing to restore from.
      */}
      <button
        className={cx('button-sm', deleteStyles.trigger)}
        type="button"
        aria-disabled={isBusy}
        data-testid="user-delete-open"
        onClick={() => onAction(person, 'delete')}
      >
        Delete
      </button>
    </div>
  )
}
