'use client'

import { Dialog } from '@base-ui-components/react/dialog'
import { useState } from 'react'

import type { AdminUserSummary } from '@/lib/admin/users'
import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { css } from '@/lib/ui/class-name'
import dialogStyles from '../../a/[id]/delete-dialog.module.css'
import styles from '../admin.module.css'
import deleteStyles from './delete-user-dialog.module.css'

/**
 * Dense table, no row animation (docs/motion.md): rows that move while an operator reads them are
 * unreadable. State changes swap text and buttons in place.
 *
 * Artifact columns are counts only. There is no route behind this table that could return a title.
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

export function UserTable({
  initialUsers,
  currentUserId,
}: {
  readonly initialUsers: readonly AdminUserSummary[]
  readonly currentUserId: string
}) {
  const [people, setPeople] = useState(initialUsers)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  function formatMoment(iso: string | null): string {
    return isMountedForLocalTime ? formatInstantLocal(iso) : formatInstantStable(iso)
  }

  async function refresh(): Promise<void> {
    const response = await fetch('/api/v1/users')
    if (!response.ok) return
    setPeople(((await response.json()) as ListResponse).data.items)
  }

  async function send(path: string, init: RequestInit): Promise<void> {
    // `aria-disabled` keeps focus but still fires; all three row actions funnel through here.
    if (isBusy) return
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(path, init)
      if (!response.ok) {
        setErrorMessage(await failureMessage(response))
        return
      }
      await refresh()
    } finally {
      setIsBusy(false)
    }
  }

  function setAccess(person: AdminUserSummary, isActive: boolean): void {
    void send(`/api/v1/users/${person.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive }),
    })
  }

  function setRole(person: AdminUserSummary, role: AdminUserSummary['role']): void {
    void send(`/api/v1/users/${person.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isActive: person.isActive, role }),
    })
  }

  // Awaited by the confirmation dialog, which closes once the request has settled either way.
  function remove(person: AdminUserSummary): Promise<void> {
    return send(`/api/v1/users/${person.id}`, { method: 'DELETE' })
  }

  return (
    <>
      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className={styles.tableScroll}>
        <table className={styles.table}>
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
              <tr key={person.id}>
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
                      onSetAccess={setAccess}
                      onSetRole={setRole}
                      onRemove={remove}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function RowActions({
  person,
  isBusy,
  onSetAccess,
  onSetRole,
  onRemove,
}: {
  readonly person: AdminUserSummary
  readonly isBusy: boolean
  readonly onSetAccess: (person: AdminUserSummary, isActive: boolean) => void
  readonly onSetRole: (person: AdminUserSummary, role: AdminUserSummary['role']) => void
  readonly onRemove: (person: AdminUserSummary) => Promise<void>
}) {
  return (
    <div className={styles.rowActions}>
      <button
        className="button-secondary button-sm"
        type="button"
        aria-disabled={isBusy}
        onClick={() => onSetAccess(person, !person.isActive)}
      >
        {person.isActive ? 'Deactivate' : 'Reactivate'}
      </button>
      <button
        className="button-secondary button-sm"
        type="button"
        aria-disabled={isBusy}
        onClick={() => onSetRole(person, person.role === 'admin' ? 'member' : 'admin')}
      >
        {person.role === 'admin' ? 'Make member' : 'Make admin'}
      </button>
      <DeleteUserDialog person={person} isBusy={isBusy} onRemove={onRemove} />
    </div>
  )
}

/**
 * The server refuses to delete an account that still owns artifacts, so the only case that
 * reaches the API is the newly-invited person who has not published yet — irreversible, with
 * nothing to restore from.
 */
function DeleteUserDialog({
  person,
  isBusy,
  onRemove,
}: {
  readonly person: AdminUserSummary
  readonly isBusy: boolean
  readonly onRemove: (person: AdminUserSummary) => Promise<void>
}) {
  const [isOpen, setIsOpen] = useState(false)

  async function handleDelete(): Promise<void> {
    if (isBusy) return
    await onRemove(person)
    // Closing on failure too — the refusal renders above the table, behind this popup.
    setIsOpen(false)
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <Dialog.Trigger
        className={`button-sm ${css(deleteStyles.trigger)}`}
        data-testid="user-delete-open"
      >
        Delete
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className={css(dialogStyles.backdrop)} />
        <Dialog.Popup className={css(dialogStyles.popup)} data-testid="user-delete-dialog">
          <Dialog.Title className={css(dialogStyles.title)}>Delete {person.email}?</Dialog.Title>
          <Dialog.Description className={css(dialogStyles.description)}>
            Their sign-in stops working and the account is removed. Their audit trail stays. This
            cannot be undone — deactivate instead if you only want to end their access.
          </Dialog.Description>

          <div className={dialogStyles.actions}>
            <button
              className={`button-sm ${dialogStyles.confirm}`}
              type="button"
              aria-disabled={isBusy}
              data-testid="user-delete-confirm"
              onClick={() => void handleDelete()}
            >
              Delete account
            </button>
            <Dialog.Close className={css(dialogStyles.cancel)}>Cancel</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
