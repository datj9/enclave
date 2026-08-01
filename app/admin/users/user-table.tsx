'use client'

import { useState } from 'react'

import type { AdminUserSummary } from '@/lib/admin/users'
import styles from '../admin.module.css'

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

function formatMoment(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString()
}

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

  async function refresh(): Promise<void> {
    const response = await fetch('/api/v1/users')
    if (!response.ok) return
    setPeople(((await response.json()) as ListResponse).data.items)
  }

  async function send(path: string, init: RequestInit): Promise<void> {
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

  function remove(person: AdminUserSummary): void {
    void send(`/api/v1/users/${person.id}`, { method: 'DELETE' })
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
                Org
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
                <td>{person.isActive ? 'active' : `deactivated ${formatMoment(person.deactivatedAt)}`}</td>
                <td className={styles.numeric}>{person.liveArtifactCount}</td>
                <td className={styles.numeric}>{person.orgArtifactCount}</td>
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
  readonly onRemove: (person: AdminUserSummary) => void
}) {
  return (
    <div className={styles.rowActions}>
      <button
        className={`button-secondary ${styles.compactButton}`}
        type="button"
        disabled={isBusy}
        onClick={() => onSetAccess(person, !person.isActive)}
      >
        {person.isActive ? 'Deactivate' : 'Reactivate'}
      </button>
      <button
        className={`button-secondary ${styles.compactButton}`}
        type="button"
        disabled={isBusy}
        onClick={() => onSetRole(person, person.role === 'admin' ? 'member' : 'admin')}
      >
        {person.role === 'admin' ? 'Make member' : 'Make admin'}
      </button>
      <button
        className={`button-secondary ${styles.compactButton}`}
        type="button"
        disabled={isBusy}
        onClick={() => onRemove(person)}
      >
        Delete
      </button>
    </div>
  )
}
