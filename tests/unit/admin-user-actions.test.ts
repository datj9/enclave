import { describe, expect, it } from 'vitest'

import {
  accessActionFor,
  needsConfirmation,
  roleActionFor,
  userActionConfirmation,
  userActionRequest,
  type UserAction,
} from '@app/admin/users/user-actions'
import type { AdminUserSummary } from '@/lib/admin/users'

/**
 * The admin user table's row actions as data. What has to hold: only Reactivate commits without
 * asking, each request body is exactly what the route used to receive, and the deactivate
 * confirmation tells the operator what stays readable.
 */

function person(overrides: Partial<AdminUserSummary> = {}): AdminUserSummary {
  return {
    id: 'user-1',
    email: 'dave@example.com',
    role: 'member',
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    deactivatedAt: null,
    liveArtifactCount: 0,
    sharedArtifactCount: 0,
    ...overrides,
  }
}

function jsonBody(action: UserAction, who: AdminUserSummary): unknown {
  const { init } = userActionRequest(action, who)
  return JSON.parse(String(init.body))
}

describe('row toggles', () => {
  it('offers Deactivate to an active account and Reactivate to a deactivated one', () => {
    expect(accessActionFor(person({ isActive: true }))).toBe('deactivate')
    expect(accessActionFor(person({ isActive: false }))).toBe('reactivate')
  })

  it('offers the opposite role', () => {
    expect(roleActionFor(person({ role: 'member' }))).toBe('make-admin')
    expect(roleActionFor(person({ role: 'admin' }))).toBe('make-member')
  })
})

describe('needsConfirmation', () => {
  it('lets only Reactivate commit on the press', () => {
    expect(needsConfirmation('reactivate')).toBe(false)
    for (const action of ['deactivate', 'make-admin', 'make-member', 'delete'] as const) {
      expect(needsConfirmation(action)).toBe(true)
    }
  })
})

describe('userActionRequest', () => {
  it('PATCHes isActive for the access toggles', () => {
    const who = person()
    expect(userActionRequest('deactivate', who).path).toBe('/api/v1/users/user-1')
    expect(userActionRequest('deactivate', who).init.method).toBe('PATCH')
    expect(jsonBody('deactivate', who)).toEqual({ isActive: false })
    expect(jsonBody('reactivate', person({ isActive: false }))).toEqual({ isActive: true })
  })

  it('sends the role with the unchanged access state', () => {
    expect(jsonBody('make-admin', person({ isActive: true }))).toEqual({
      isActive: true,
      role: 'admin',
    })
    expect(jsonBody('make-member', person({ role: 'admin', isActive: false }))).toEqual({
      isActive: false,
      role: 'member',
    })
  })

  it('sends JSON with a content type the route accepts', () => {
    expect(userActionRequest('make-admin', person()).init.headers).toEqual({
      'content-type': 'application/json',
    })
  })

  it('DELETEs with no body for delete', () => {
    const { path, init } = userActionRequest('delete', person())
    expect(path).toBe('/api/v1/users/user-1')
    expect(init).toEqual({ method: 'DELETE' })
  })
})

describe('userActionConfirmation', () => {
  it('names the account in every title', () => {
    for (const action of ['deactivate', 'make-admin', 'make-member', 'delete'] as const) {
      expect(userActionConfirmation(action, person()).title).toContain('dave@example.com')
    }
  })

  it('marks the access-ending and permanent actions as danger', () => {
    expect(userActionConfirmation('deactivate', person()).tone).toBe('danger')
    expect(userActionConfirmation('delete', person()).tone).toBe('danger')
    expect(userActionConfirmation('make-admin', person()).tone).toBe('default')
    expect(userActionConfirmation('make-member', person()).tone).toBe('default')
  })

  it('tells the operator how many shared artifacts stay readable after deactivating', () => {
    expect(userActionConfirmation('deactivate', person({ sharedArtifactCount: 0 })).body).toContain(
      'Nothing they published is shared with others.',
    )
    expect(userActionConfirmation('deactivate', person({ sharedArtifactCount: 1 })).body).toContain(
      'Their 1 shared artifact stays readable.',
    )
    expect(userActionConfirmation('deactivate', person({ sharedArtifactCount: 3 })).body).toContain(
      'Their 3 shared artifacts stay readable.',
    )
  })

  it('gives every confirmation an in-progress busy label', () => {
    const labels = (['deactivate', 'make-admin', 'make-member', 'delete'] as const).map(
      (action) => userActionConfirmation(action, person()).busyLabel,
    )
    for (const label of labels) expect(label.endsWith('…')).toBe(true)
  })
})
