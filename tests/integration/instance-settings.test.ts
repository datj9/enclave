import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { instanceSettings } from '@/db/schema/instance-settings'
import { users } from '@/db/schema/users'
import { probeServices } from './services'

/**
 * `GET`/`PATCH /api/v1/admin/settings` (spec: categories-taxonomy §`GET` / `PATCH
 * /api/v1/admin/settings`) against real Postgres. All tests are [must-fail] at RED: the route
 * module and the `instance_settings` table do not exist yet.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/instance-settings: no database on DATABASE_URL.')
}

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

const { GET, PATCH } = await import('@app/api/v1/admin/settings/route')

const ADMIN_EMAIL = 'instance-settings-admin@example.test'
const MEMBER_EMAIL = 'instance-settings-member@example.test'

const AUTO_CATEGORIZE_KEY = 'auto_categorize_enabled'

function settingsRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/v1/admin/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createUser(email: string, role: 'admin' | 'member'): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: null, role, isActive: true })
    .returning({ id: users.id })

  if (row === undefined) throw new Error(`could not create the instance-settings test ${role}`)
  return row.id
}

describe.skipIf(!database)('/api/v1/admin/settings', () => {
  let adminId = ''
  let memberId = ''

  beforeAll(async () => {
    adminId = await createUser(ADMIN_EMAIL, 'admin')
    memberId = await createUser(MEMBER_EMAIL, 'member')
  })

  afterAll(async () => {
    // Clean up this file's own rows: the instance_settings row first (it references users),
    // then the users.
    await db.delete(instanceSettings).where(eq(instanceSettings.key, AUTO_CATEGORIZE_KEY))
    await db.delete(users).where(inArray(users.id, [adminId, memberId]))
  })

  it('GET answers autoCategorizeEnabled false on a fresh instance', async () => {
    mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }
    const response = await GET()

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly data: { readonly autoCategorizeEnabled: boolean }
    }
    expect(body.data.autoCategorizeEnabled).toBe(false)
  })

  it('PATCH enables auto-categorize and the next GET reports it', async () => {
    mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }

    const patched = await PATCH(settingsRequest({ autoCategorizeEnabled: true }))
    expect(patched.status).toBe(200)
    const patchedBody = (await patched.json()) as {
      readonly data: { readonly autoCategorizeEnabled: boolean }
    }
    expect(patchedBody.data.autoCategorizeEnabled).toBe(true)

    const fetched = await GET()
    const fetchedBody = (await fetched.json()) as {
      readonly data: { readonly autoCategorizeEnabled: boolean }
    }
    expect(fetchedBody.data.autoCategorizeEnabled).toBe(true)
  })

  it('PATCH rejects a member with 403', async () => {
    mocks.sessionUser = { id: memberId, email: MEMBER_EMAIL, role: 'member', isActive: true }
    const response = await PATCH(settingsRequest({ autoCategorizeEnabled: false }))

    expect(response.status).toBe(403)
  })

  it('GET rejects an unauthenticated caller with 401', async () => {
    mocks.sessionUser = null
    const response = await GET()

    expect(response.status).toBe(401)
  })
})