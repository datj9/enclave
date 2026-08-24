import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { auditLog } from '@/db/schema/audit-log'
import { categories } from '@/db/schema/categories'
import { users } from '@/db/schema/users'
import { probeServices } from './services'

/**
 * `POST`/`GET /api/v1/categories` and `PATCH /api/v1/categories/[id]` (spec:
 * categories-taxonomy §`GET` / `POST /api/v1/categories`, §`PATCH /api/v1/categories/[id]`)
 * against real Postgres. All tests are [must-fail] at RED: the route modules and the
 * `categories` table do not exist yet.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/categories: no database on DATABASE_URL.')
}

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

const { GET, POST } = await import('@app/api/v1/categories/route')
const { PATCH } = await import('@app/api/v1/categories/[id]/route')

const ADMIN_EMAIL = 'categories-admin@example.test'
const MEMBER_EMAIL = 'categories-member@example.test'

// Category names are globally unique, so a name shared with another test file fails as soon as
// vitest runs the two in parallel against the same database.
const DOCS_NAME = 'Category Docs'
const DOCS_SLUG = 'category-docs'

let adminId = ''
let memberId = ''

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function listRequest(url: string = 'http://localhost:3000/api/v1/categories'): Request {
  return new Request(url)
}

function categoryRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/v1/categories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function patchRequest(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/v1/categories/${id}`, {
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

  if (row === undefined) throw new Error(`could not create the categories test ${role}`)
  return row.id
}

async function adminPost(name: string): Promise<Response> {
  mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }
  return POST(categoryRequest({ name }))
}

describe.skipIf(!database)('/api/v1/categories', () => {
  beforeAll(async () => {
    adminId = await createUser(ADMIN_EMAIL, 'admin')
    memberId = await createUser(MEMBER_EMAIL, 'member')
  })

  afterAll(async () => {
    // Clean up this file's own rows: categories first (they reference users), then users.
    await db.delete(categories).where(inArray(categories.createdBy, [adminId, memberId]))
    await db.delete(users).where(inArray(users.id, [adminId, memberId]))
  })

  it('POST creates an active category and returns its derived slug', async () => {
    const response = await adminPost(DOCS_NAME)

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      readonly data: {
        readonly name: string
        readonly slug: string
        readonly description: string | null
        readonly isActive: boolean
        readonly createdAt: string
      }
    }
    expect(body.data.name).toBe(DOCS_NAME)
    expect(body.data.slug).toBe(DOCS_SLUG)
    expect(body.data.description).toBeNull()
    expect(body.data.isActive).toBe(true)
    expect(body.data.createdAt).toMatch(ISO_8601)
  })

  it('POST rejects a member with 403 and writes no row', async () => {
    mocks.sessionUser = { id: memberId, email: MEMBER_EMAIL, role: 'member', isActive: true }
    const response = await POST(categoryRequest({ name: DOCS_NAME }))

    expect(response.status).toBe(403)

    const rows = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.createdBy, memberId))
    expect(rows).toHaveLength(0)
  })

  it('POST rejects a duplicate name that differs only in case with 422', async () => {
    expect((await adminPost('Data Dashboards')).status).toBe(201)

    const response = await adminPost('DATA DASHBOARDS')

    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      readonly error: { readonly details: { readonly fields: readonly string[] } }
    }
    expect(body.error.details.fields).toEqual(['name'])
  })

  it('GET returns only active categories to a member', async () => {
    await adminPost('Alpha')
    const beta = (await (await adminPost('Beta')).json()) as { readonly data: { readonly id: string } }

    mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }
    await PATCH(patchRequest(beta.data.id, { isActive: false }))

    mocks.sessionUser = { id: memberId, email: MEMBER_EMAIL, role: 'member', isActive: true }
    const response = await GET(listRequest())

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly data: {
        readonly items: readonly { readonly slug: string; readonly isActive: boolean }[]
      }
    }
    const slugs = body.data.items.map((item) => item.slug)
    expect(slugs).toContain('alpha')
    expect(slugs).not.toContain('beta')
    expect(body.data.items.every((item) => item.isActive)).toBe(true)
  })

  it('GET with includeInactive rejects a member with 403', async () => {
    mocks.sessionUser = { id: memberId, email: MEMBER_EMAIL, role: 'member', isActive: true }
    const response = await GET(new Request('http://localhost:3000/api/v1/categories?includeInactive=true'))

    expect(response.status).toBe(403)
  })

  it('PATCH renames a category and recomputes its slug', async () => {
    const created = (await (await adminPost('Renamable')).json()) as {
      readonly data: { readonly id: string }
    }

    mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }
    const response = await PATCH(patchRequest(created.data.id, { name: 'Renamed' }))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly data: { readonly name: string; readonly slug: string }
    }
    expect(body.data.name).toBe('Renamed')
    expect(body.data.slug).toBe('renamed')
  })

  it('PATCH deactivating a category removes it from the member listing', async () => {
    const created = (await (await adminPost('Removables')).json()) as {
      readonly data: { readonly id: string }
    }

    mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }
    const deactivated = await PATCH(patchRequest(created.data.id, { isActive: false }))
    const deactivatedBody = (await deactivated.json()) as {
      readonly data: { readonly isActive: boolean }
    }
    expect(deactivated.status).toBe(200)
    expect(deactivatedBody.data.isActive).toBe(false)

    mocks.sessionUser = { id: memberId, email: MEMBER_EMAIL, role: 'member', isActive: true }
    const listing = (await (await GET(listRequest())).json()) as {
      readonly data: { readonly items: readonly { readonly slug: string }[] }
    }
    const slugs = listing.data.items.map((item) => item.slug)
    expect(slugs).not.toContain('removables')
  })

  it('PATCH on an unknown id answers 404', async () => {
    mocks.sessionUser = { id: adminId, email: ADMIN_EMAIL, role: 'admin', isActive: true }
    const response = await PATCH(patchRequest(crypto.randomUUID(), { isActive: false }))

    expect(response.status).toBe(404)
    const body = (await response.json()) as { readonly error: { readonly code: string } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('POST records a category.create audit event naming the admin', async () => {
    const response = await adminPost('Audited')

    expect(response.status).toBe(201)

    const events = await db
      .select({ id: auditLog.id, actorUserId: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'category.create'), eq(auditLog.actorUserId, adminId)))

    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.actorUserId === adminId)).toBe(true)
  })
})