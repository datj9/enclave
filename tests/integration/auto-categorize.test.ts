import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { artifactCategories, categories } from '@/db/schema/categories'
import { instanceSettings } from '@/db/schema/instance-settings'
import { users } from '@/db/schema/users'
import type { BundleFile } from '@/lib/bundle/validate'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { appendVersion } from '@/lib/artifacts/versions'
import { createCategory } from '@/lib/categories/manage'
import { applyModelTags } from '@/lib/artifacts/tags'
import { AUTO_CATEGORIZE_KEY, setAutoCategorizeEnabled } from '@/lib/settings/instance-settings'
import type { ObjectStore } from '@/lib/storage/object-store'
import { createTestOwner, createTestStore, probeServices } from './services'

/**
 * Spec: auto-categorize — the hooks in `createArtifactWithBundle` and `appendVersion` classify a
 * new version against the admin's taxonomy with one instance-key LLM call, best-effort throughout.
 * All tests are [must-fail] at RED: `src/lib/generation/collect.ts` and
 * `src/lib/categories/classify.ts` do not exist yet, so the upload modules cannot import them.
 *
 * The provider is mocked at `src/lib/generation/collect.ts` — that module exists as a seam
 * precisely so this suite never makes a network call. `mocks.calls` proves a gate short-circuited
 * before any provider call.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/auto-categorize: database=${database} storage=${storage}. ` +
      'Start them with `docker compose --profile minio up -d` and run `pnpm db:migrate`.',
  )
}

const mocks = vi.hoisted(() => ({
  completion: null as string | null,
  calls: 0,
  shouldThrow: false,
}))

vi.mock('@/lib/generation/collect', () => ({
  collectCompletion: () => {
    mocks.calls += 1
    if (mocks.shouldThrow) return Promise.resolve(null)
    return Promise.resolve(mocks.completion)
  },
}))

const OWNER_EMAIL = 'auto-categorize-owner@example.test'
const ADMIN_EMAIL = 'auto-categorize-admin@example.test'

// Category names are globally unique, and `listCategories` is instance-wide, so a name shared
// with another test file both fails this file's setup and lets its slug match the wrong id.
const DOCS_NAME = 'Autocat Docs'
const DOCS_REPLY = '["autocat-docs"]'

function bundle(marker: string): BundleFile[] {
  return [{ path: 'index.html', content: Buffer.from(`<!doctype html><p>${marker}`, 'utf8') }]
}

function categoryRows(artifactId: string) {
  return db
    .select({ categoryId: artifactCategories.categoryId })
    .from(artifactCategories)
    .where(eq(artifactCategories.artifactId, artifactId))
}

let store: ObjectStore
let ownerId = ''
let adminId = ''
let docsId = ''

describe.skipIf(!servicesReady)('auto-categorize', () => {
  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()

    ownerId = await createTestOwner(OWNER_EMAIL)
    adminId = await createTestOwner(ADMIN_EMAIL)

    const docs = await createCategory({
      name: DOCS_NAME,
      description: 'The documentation category',
      createdBy: adminId,
    })
    docsId = docs.id
  })

  afterAll(async () => {
    // Clean up every row this file created: the instance_settings row first (it references
    // users), then the join rows, then categories, artifacts and users.
    await db.delete(instanceSettings).where(eq(instanceSettings.key, AUTO_CATEGORIZE_KEY))

    const owned = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
    const ownedIds = owned.map((artifact) => artifact.id)
    if (ownedIds.length > 0) {
      await db.delete(artifactCategories).where(inArray(artifactCategories.artifactId, ownedIds))
    }
    for (const artifact of owned) await store.deletePrefix(`artifacts/${artifact.id}/`)

    await db.delete(categories).where(eq(categories.createdBy, adminId))
    await db.delete(artifacts).where(eq(artifacts.ownerId, ownerId))
    await db.delete(users).where(eq(users.id, ownerId))
    await db.delete(users).where(eq(users.id, adminId))
  })

  it('an upload writes model-sourced tags when the setting is on', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = false
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Auto categorized', visibility: 'private', files: bundle('one') },
      store,
    )

    expect(mocks.calls).toBe(1)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('model')
  })

  it('an upload writes no tags when the setting is off', async () => {
    await setAutoCategorizeEnabled(false, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = false
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Not auto categorized', visibility: 'private', files: bundle('two') },
      store,
    )

    expect(mocks.calls).toBe(0)
    expect(await categoryRows(created.id)).toHaveLength(0)
  })

  it('an upload writes no tags when no category is active', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = false
    mocks.calls = 0
    await db.update(categories).set({ isActive: false }).where(eq(categories.id, docsId))

    try {
      const created = await createArtifactWithBundle(
        { ownerId, title: 'No active category', visibility: 'private', files: bundle('three') },
        store,
      )

      expect(mocks.calls).toBe(0)
      expect(await categoryRows(created.id)).toHaveLength(0)
    } finally {
      await db.update(categories).set({ isActive: true }).where(eq(categories.id, docsId))
    }
  })

  it('an unparseable reply leaves the artifact untagged and the upload successful', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = 'garbage'
    mocks.shouldThrow = false
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Garbage reply', visibility: 'private', files: bundle('four') },
      store,
    )

    expect(created.id).toBeTruthy()
    expect(mocks.calls).toBe(1)
    expect(await categoryRows(created.id)).toHaveLength(0)
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('model')
  })

  it('a provider failure leaves the artifact untagged and the upload successful', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = true
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Provider failure', visibility: 'private', files: bundle('five') },
      store,
    )

    expect(created.id).toBeTruthy()
    expect(mocks.calls).toBe(1)
    expect(await categoryRows(created.id)).toHaveLength(0)
  })

  it('a new version re-classifies an artifact whose source is model', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = false
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Re-classified', visibility: 'private', files: bundle('six') },
      store,
    )
    mocks.calls = 0

    await appendVersion(
      { artifactId: created.id, ownerId, files: bundle('seven') },
      store,
    )

    expect(mocks.calls).toBe(1)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('model')
  })

  it('an unparseable reply on a later version leaves existing model tags in place', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = false
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Later garbage reply', visibility: 'private', files: bundle('ten') },
      store,
    )
    expect(mocks.calls).toBe(1)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    mocks.completion = 'garbage'
    mocks.calls = 0

    await appendVersion(
      { artifactId: created.id, ownerId, files: bundle('eleven') },
      store,
    )

    expect(mocks.calls).toBe(1)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('model')
  })

  it('applyModelTags is a no-op when the owner flipped the source to manual mid-flight', async () => {
    const created = await createArtifactWithBundle(
      { ownerId, title: 'Mid-flight manual', visibility: 'private', files: bundle('twelve') },
      store,
    )
    await db.update(artifacts).set({ categorySource: 'manual' }).where(eq(artifacts.id, created.id))
    await db
      .insert(artifactCategories)
      .values({ artifactId: created.id, categoryId: docsId })
      .onConflictDoNothing()

    await applyModelTags(created.id, [])

    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('manual')
  })

  it('a new version leaves a manually-tagged artifact untouched', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY
    mocks.shouldThrow = false
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Manually tagged', visibility: 'private', files: bundle('eight') },
      store,
    )
    await db.update(artifacts).set({ categorySource: 'manual' }).where(eq(artifacts.id, created.id))
    await db
      .insert(artifactCategories)
      .values({ artifactId: created.id, categoryId: docsId })
      .onConflictDoNothing()
    const before = (await categoryRows(created.id)).map((row) => row.categoryId)
    mocks.calls = 0

    await appendVersion(
      { artifactId: created.id, ownerId, files: bundle('nine') },
      store,
    )

    expect(mocks.calls).toBe(0)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual(before)
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('manual')
  })
})
