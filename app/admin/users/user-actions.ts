import type { AdminUserSummary } from '@/lib/admin/users'

/**
 * The admin's row actions on another account, as data: what each one sends and, for the ones that
 * ask first, what the confirmation says. Kept free of React so the wording and the request bodies
 * are unit-tested without rendering the table.
 *
 * Reactivating is the one action that commits on the press: it restores access and cannot lock
 * anyone out. Everything else either ends someone's access, changes what they may do to the whole
 * instance, or is permanent — each of those says so first.
 */

export type UserAction = 'deactivate' | 'reactivate' | 'make-admin' | 'make-member' | 'delete'

export type ConfirmedUserAction = Exclude<UserAction, 'reactivate'>

export interface UserActionRequest {
  readonly path: string
  readonly init: RequestInit
}

export interface UserActionConfirmation {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string
  /** The confirm button's text while the request is in flight. */
  readonly busyLabel: string
  readonly tone: 'default' | 'danger'
}

/** The access toggle the row offers for this person. */
export function accessActionFor(person: AdminUserSummary): 'deactivate' | 'reactivate' {
  return person.isActive ? 'deactivate' : 'reactivate'
}

/** The role toggle the row offers for this person. */
export function roleActionFor(person: AdminUserSummary): 'make-admin' | 'make-member' {
  return person.role === 'admin' ? 'make-member' : 'make-admin'
}

export function needsConfirmation(action: UserAction): action is ConfirmedUserAction {
  return action !== 'reactivate'
}

export function userActionRequest(action: UserAction, person: AdminUserSummary): UserActionRequest {
  const path = `/api/v1/users/${person.id}`
  switch (action) {
    case 'deactivate':
    case 'reactivate':
      return patch(path, { isActive: action === 'reactivate' })
    case 'make-admin':
    case 'make-member':
      // `isActive` rides along unchanged: the route validates the whole access state it is given.
      return patch(path, {
        isActive: person.isActive,
        role: action === 'make-admin' ? 'admin' : 'member',
      })
    case 'delete':
      return { path, init: { method: 'DELETE' } }
  }
}

function patch(path: string, body: Record<string, unknown>): UserActionRequest {
  return {
    path,
    init: {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  }
}

export function userActionConfirmation(
  action: ConfirmedUserAction,
  person: AdminUserSummary,
): UserActionConfirmation {
  const { email } = person
  switch (action) {
    case 'deactivate':
      return {
        title: `Deactivate ${email}?`,
        body: `Their sessions end now and they can no longer sign in or write. ${sharedSentence(person.sharedArtifactCount)} You can reactivate the account later.`,
        confirmLabel: 'Deactivate',
        busyLabel: 'Deactivating…',
        tone: 'danger',
      }
    case 'make-admin':
      return {
        title: `Make ${email} an admin?`,
        body: 'Admins manage every account, invite, category and instance setting, and read the audit log. They still cannot open anyone else’s private artifacts.',
        confirmLabel: 'Make admin',
        busyLabel: 'Saving…',
        tone: 'default',
      }
    case 'make-member':
      return {
        title: `Remove admin from ${email}?`,
        body: 'They lose the admin console at once and keep an ordinary member account.',
        confirmLabel: 'Make member',
        busyLabel: 'Saving…',
        tone: 'default',
      }
    case 'delete':
      return {
        title: `Delete ${email}?`,
        body: 'Their sign-in stops working and the account is removed. Their audit trail stays. This cannot be undone — deactivate instead if you only want to end their access.',
        confirmLabel: 'Delete account',
        busyLabel: 'Deleting…',
        tone: 'danger',
      }
  }
}

/** The operator's question before deactivating is what stays readable; the Shared count answers it. */
function sharedSentence(sharedArtifactCount: number): string {
  if (sharedArtifactCount === 0) return 'Nothing they published is shared with others.'
  return sharedArtifactCount === 1
    ? 'Their 1 shared artifact stays readable.'
    : `Their ${sharedArtifactCount} shared artifacts stay readable.`
}
