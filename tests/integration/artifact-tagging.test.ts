import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { GET as listRoute } from '@app/api/v1/artifacts/route'
import { PATCH as patchRoute } from '@app/api/v1/artifacts/[id]/route'
import { db } from '@/db'
import { artifactCategories, categories } from '@/db/schema/categories'
import { artifacts } from '@/db/schema/artifacts'
import { users } from '@/db/schema/users'
import type { BundleFile } from '@/lib/bundle/validate'
import { readArtifactPage } from '@/lib/artifacts/page-read'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { artifactPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { createTestOwner, createTestStore, probeServices } from './services'

/**
 * Spec: artifact-tagging — `PATCH /api/v1/artifacts/{id}` gains `categoryIds`, the list gains a
 * `categories` array per item and a `?category=<slug>` filter, and the public page read includes
 * active tags. All tests are [must-fail] at RED: the `replaceArtifactTags` module does not exist
 * yet, so the PATCH handler (extended) and the list/page-read changes do not either.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/artifact-tagging: database=${database} storage=${storage}. ` +
      'Start them with `docker compose --profile minio up -d` and run `pnpm db:migrate`.',
  )
}

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

const OWNER_EMAIL = 'tagging-owner@example.test'
const OTHER_EMAIL = 'tagging-other@example.test'

const API_URL = 'http://localhost:3000'

function patchRequest(artifactId: string, body: unknown): Request {
  return new Request(`${API_URL}/api/v1/artifacts/${artifactId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function listRequest(search: string): Request {
  return new Request(`${API_URL}/api/v1/artifacts${search}`)
}

function patch(artifactId: string, body: unknown): Promise<Response> {
  return patchRoute(patchRequest(artifactId, body), {
    params: Promise.resolve({ id: artifactId }),
  })
}

function bundle(marker: string): BundleFile[] {
  return [{ path: 'index.html', content: Buffer.from(`<!doctype html><p>${marker}`, 'utf8') }]
}

function categoryRows(artifactId: string) {
  return db
    .select({ categoryId: artifactCategories.categoryId })
    .from(artifactCategories)
    .where(eq(artifactCategories.artifactId, artifactId))
}

async function createTaggedArtifact(ownerId: string, title: string): Promise<string> {
  return (await createArtifactWithBundle(
    { ownerId, title, visibility: 'private', files: bundle(title) },
    store,
  )).id
}

let store: ObjectStore
let ownerId = ''
let otherId = ''
let docsId = ''
let inactiveId = ''

describe.skipIf(!servicesReady)('artifact tagging', () => {
  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()

    ownerId = await createTestOwner(OWNER_EMAIL)
    const [other] = await db
      .insert(users)
      .values({ email: OTHER_EMAIL, passwordHash: null, role: 'member', isActive: true })
      .returning({ id: users.id })
    if (other === undefined) throw new Error('could not create the tagging test member')
    otherId = other.id

    const [docs] = await db
      .insert(categories)
      .values({ name: 'Docs', slug: 'docs', createdBy: ownerId })
      .returning({ id: categories.id })
    if (docs === undefined) throw new Error('could not create the docs category')
    docsId = docs.id

    const [inactive] = await db
      .insert(categories)
      .values({
        name: 'Inactive',
        slug: 'inactive',
        description: null,
        isActive: false,
        createdBy: ownerId,
      })
      .returning({ id: categories.id })
    if (inactive === undefined) throw new Error('could not create the inactive category')
    inactiveId = inactive.id
  })

  afterAll(async () => {
    // Full cleanup of every row this file created: join rows first (they reference artifacts
    // and categories), then categories (they reference users), then artifacts and users.
    const owned = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.ownerId, ownerId))
    const ownedIds = owned.map((artifact) => artifact.id)
    if (ownedIds.length > 0) {
      await db.delete(artifactCategories).where(inArray(artifactCategories.artifactId, ownedIds))
    }
    for (const artifact of owned) await store.deletePrefix(artifactPrefix(artifact.id))

    await db.delete(categories).where(eq(categories.createdBy, ownerId))
    await db.delete(artifacts).where(eq(artifacts.ownerId, ownerId))
    await db.delete(users).where(eq(users.id, ownerId))
    await db.delete(users).where(eq(users.id, otherId))
  })

  it('PATCH replaces the tag set and marks the source manual', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Tagged by patch')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const response = await patch(artifactId, { categoryIds: [docsId] })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { readonly data: { readonly categories: readonly { readonly slug: string }[] } }
    expect(body.data.categories).toEqual([{ slug: 'docs' }])
    expect((await categoryRows(artifactId)).map((row) => row.categoryId)).toEqual([docsId])

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId))
    expect(artifact?.categorySource).toBe('manual')
  })

  it('PATCH with an empty array clears every tag', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Clear my tags')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    expect((await patch(artifactId, { categoryIds: [docsId] })).status).toBe(200)

    const response = await patch(artifactId, { categoryIds: [] })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { readonly data: { readonly categories: readonly unknown[] } }
    expect(body.data.categories).toEqual([])
    expect(await categoryRows(artifactId)).toHaveLength(0)

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId))
    expect(artifact?.categorySource).toBe('manual')
  })

  it('PATCH de-duplicates repeated category ids into one row', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Duplicate tags')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const response = await patchRoute(
      patchRequest(artifactId, { categoryIds: [docsId, docsId] }),
      { params: Promise.resolve({ id: artifactId }) },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { readonly data: { readonly categories: readonly { readonly slug: string }[] } }
    expect(body.data.categories).toEqual([{ slug: 'docs' }])
    expect(await categoryRows(artifactId)).toHaveLength(1)
  })

  it('PATCH rejects an inactive category and changes no rows', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Reject inactive')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const response = await patch(artifactId, { categoryIds: [inactiveId] })

    expect(response.status).toBe(422)
    const body = (await response.json()) as { readonly error: { readonly details: { readonly fields: readonly string[] } } }
    expect(body.error.details.fields).toEqual(['categoryIds'])
    expect(await categoryRows(artifactId)).toHaveLength(0)

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId))
    expect(artifact?.categorySource).toBe('model')
  })

  it('PATCH rejects an unknown category id and changes no rows', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Reject unknown')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const response = await patchRoute(
      patchRequest(artifactId, { categoryIds: [crypto.randomUUID()] }),
      { params: Promise.resolve({ id: artifactId }) },
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { readonly error: { readonly details: { readonly fields: readonly string[] } } }
    expect(body.error.details.fields).toEqual(['categoryIds'])
    expect(await categoryRows(artifactId)).toHaveLength(0)
  })

  it('PATCH rejects more than ten categories', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Too many tags')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const response = await patchRoute(
      patchRequest(artifactId, { categoryIds: Array.from({ length: 11 }, () => crypto.randomUUID()) }),
      { params: Promise.resolve({ id: artifactId }) },
    )

    expect(response.status).toBe(422)
    const body = (await response.json()) as { readonly error: { readonly details: { readonly fields: readonly string[] } } }
    expect(body.error.details.fields).toEqual(['categoryIds'])
    expect(await categoryRows(artifactId)).toHaveLength(0)
  })

  it('PATCH by a member who does not own the artifact is refused', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Not yours')
    mocks.sessionUser = { id: otherId, email: OTHER_EMAIL, role: 'member', isActive: true }

    const response = await patch(artifactId, { categoryIds: [] })

    expect([403, 404]).toContain(response.status)
    expect(await categoryRows(artifactId)).toHaveLength(0)
  })

  it('PATCH of the title alone leaves tags and category_source untouched', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Rename only')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    expect((await patch(artifactId, { categoryIds: [docsId] })).status).toBe(200)

    const response = await patch(artifactId, { title: 'Renamed only' })

    expect(response.status).toBe(200)
    expect(await categoryRows(artifactId)).toHaveLength(1)

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId))
    expect(artifact?.categorySource).toBe('manual')
  })

  it('the list returns each artifact with its active tags', async () => {
    const tagged = await createTaggedArtifact(ownerId, 'Tagged listing')
    const untagged = await createTaggedArtifact(ownerId, 'Untagged listing')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    expect((await patch(tagged, { categoryIds: [docsId] })).status).toBe(200)

    const response = await listRoute(listRequest(''))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly data: { readonly items: readonly { readonly id: string; readonly categories: readonly { readonly slug: string }[] }[] }
    }
    const byId = new Map(body.data.items.map((item) => [item.id, item]))
    expect(byId.get(tagged)?.categories).toMatchObject([{ slug: 'docs' }])
    expect(byId.get(untagged)?.categories).toEqual([])
  })

  it('the list filtered by category returns only tagged artifacts', async () => {
    const tagged = await createTaggedArtifact(ownerId, 'Filter target')
    const untagged = await createTaggedArtifact(ownerId, 'Filter bystander')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    expect((await patch(tagged, { categoryIds: [docsId] })).status).toBe(200)

    const response = await listRoute(listRequest('?category=docs'))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly data: { readonly items: readonly { readonly id: string; readonly categories: readonly { readonly slug: string }[] }[]; readonly nextCursor: string | null }
    }
    const ids = body.data.items.map((item) => item.id)
    expect(ids).toContain(tagged)
    expect(ids).not.toContain(untagged)
    expect(body.data.items[0]?.categories).toMatchObject([{ slug: 'docs' }])
  })

  it('the list filtered by an unused slug returns an empty page', async () => {
    await createTaggedArtifact(ownerId, 'Unused slug bystander')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }

    const response = await listRoute(listRequest('?category=nobody-uses-this'))

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly data: { readonly items: readonly unknown[]; readonly nextCursor: string | null }
    }
    expect(body.data.items).toEqual([])
    expect(body.data.nextCursor).toBeNull()
  })

  it('a deactivated category disappears from the artifact list tags', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Deactivated tag')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    expect((await patch(artifactId, { categoryIds: [docsId] })).status).toBe(200)
    await db.update(categories).set({ isActive: false }).where(eq(categories.id, docsId))

    try {
      const response = await listRoute(listRequest(''))

      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        readonly data: { readonly items: readonly { readonly id: string; readonly categories: readonly unknown[] }[] }
      }
      expect(body.data.items.find((item) => item.id === artifactId)?.categories).toEqual([])
    } finally {
      await db.update(categories).set({ isActive: true }).where(eq(categories.id, docsId))
    }
  })

  it('the public page read includes active tags only', async () => {
    const artifactId = await createTaggedArtifact(ownerId, 'Public page tags')
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    expect((await patch(artifactId, { categoryIds: [docsId] })).status).toBe(200)
    await db.update(categories).set({ isActive: false }).where(eq(categories.id, docsId))

    try {
      mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
      const read = await readArtifactPage(artifactId)

      expect(read.kind).toBe('ok')
      if (read.kind === 'ok') {
        expect(read.categories).toEqual([])
      }
    } finally {
      await db.update(categories).set({ isActive: true }).where(eq(categories.id, docsId))
    }
  })
})
