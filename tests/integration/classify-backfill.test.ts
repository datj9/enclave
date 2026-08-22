import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { artifactCategories, categories } from '@/db/schema/categories'
import { instanceSettings } from '@/db/schema/instance-settings'
import { users } from '@/db/schema/users'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { replaceArtifactTags } from '@/lib/artifacts/tags'
import { userViewerRef } from '@/lib/artifacts/authorize'
import type { BundleFile } from '@/lib/bundle/validate'
import { createCategory } from '@/lib/categories/manage'
import { backfillArtifactCategories } from '@/jobs/classify-backfill'
import { AUTO_CATEGORIZE_KEY, setAutoCategorizeEnabled } from '@/lib/settings/instance-settings'
import type { ObjectStore } from '@/lib/storage/object-store'
import { createTestOwner, createTestStore, probeServices } from './services'

/**
 * Spec: classify-backfill — the one-shot operator job that tags artifacts created before
 * auto-categorize was turned on. The provider is mocked at `collect.ts` so this never makes a
 * network call.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/classify-backfill: database=${database} storage=${storage}. ` +
      'Start them with `docker compose --profile minio up -d` and run `pnpm db:migrate`.',
  )
}

const mocks = vi.hoisted(() => ({
  completion: null as string | null,
  calls: 0,
}))

vi.mock('@/lib/generation/collect', () => ({
  collectCompletion: () => {
    mocks.calls += 1
    return Promise.resolve(mocks.completion)
  },
}))

const OWNER_EMAIL = 'classify-backfill-owner@example.test'
const ADMIN_EMAIL = 'classify-backfill-admin@example.test'

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

describe.skipIf(!servicesReady)('classify-backfill', () => {
  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()

    ownerId = await createTestOwner(OWNER_EMAIL)
    adminId = await createTestOwner(ADMIN_EMAIL)

    const docs = await createCategory({
      name: 'Docs',
      description: 'The documentation category',
      createdBy: adminId,
    })
    docsId = docs.id
  })

  afterEach(async () => {
    const owned = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
    const ownedIds = owned.map((artifact) => artifact.id)
    if (ownedIds.length > 0) {
      await db.delete(artifactCategories).where(inArray(artifactCategories.artifactId, ownedIds))
    }
    for (const artifact of owned) await store.deletePrefix(`artifacts/${artifact.id}/`)
    await db.delete(artifacts).where(eq(artifacts.ownerId, ownerId))
  })

  afterAll(async () => {
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

  it('does not classify when the setting is off, but still reports eligible artifacts', async () => {
    await setAutoCategorizeEnabled(false, adminId)
    mocks.completion = '["docs"]'
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Before opt-in', visibility: 'private', files: bundle('off') },
      store,
    )

    const result = await backfillArtifactCategories(store, { ownerId })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 0, skippedCount: 0 })
    expect(mocks.calls).toBe(0)
    expect(await categoryRows(created.id)).toHaveLength(0)
  })

  it('classifies an untagged model-sourced artifact once the setting is on', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = '["docs"]'
    mocks.calls = 0

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Eligible for backfill', visibility: 'private', files: bundle('on') },
      store,
    )
    await db.delete(artifactCategories).where(eq(artifactCategories.artifactId, created.id))
    await db.update(artifacts).set({ categorySource: 'model' }).where(eq(artifacts.id, created.id))
    mocks.calls = 0

    const result = await backfillArtifactCategories(store, { ownerId })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 1, skippedCount: 0 })
    expect(mocks.calls).toBe(1)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('model')
  })

  it('leaves a manually-tagged artifact untouched', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = '["docs"]'

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Manual curation', visibility: 'private', files: bundle('manual') },
      store,
    )
    await replaceArtifactTags({
      artifactId: created.id,
      categoryIds: [docsId],
      viewerRef: userViewerRef(ownerId),
    })
    mocks.calls = 0

    await backfillArtifactCategories(store, { ownerId })

    expect(mocks.calls).toBe(0)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.categorySource).toBe('manual')
  })

  it('skips an already-tagged model-sourced artifact', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = '["docs"]'

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Already tagged', visibility: 'private', files: bundle('tagged') },
      store,
    )
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
    mocks.calls = 0

    await backfillArtifactCategories(store, { ownerId })

    expect(mocks.calls).toBe(0)
    expect((await categoryRows(created.id)).map((row) => row.categoryId)).toEqual([docsId])
  })

  it('skips a trashed artifact', async () => {
    await setAutoCategorizeEnabled(false, adminId)
    const created = await createArtifactWithBundle(
      { ownerId, title: 'In the trash', visibility: 'private', files: bundle('trash') },
      store,
    )
    await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, created.id))
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = '["docs"]'
    mocks.calls = 0

    await backfillArtifactCategories(store, { ownerId })

    expect(mocks.calls).toBe(0)
    expect(await categoryRows(created.id)).toHaveLength(0)
  })

  it('skips an artifact whose entry object is missing', async () => {
    await setAutoCategorizeEnabled(false, adminId)
    const created = await createArtifactWithBundle(
      { ownerId, title: 'Missing object', visibility: 'private', files: bundle('missing') },
      store,
    )
    await store.deletePrefix(`artifacts/${created.id}/`)
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = '["docs"]'
    mocks.calls = 0

    const result = await backfillArtifactCategories(store, { ownerId })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 0, skippedCount: 1 })
    expect(mocks.calls).toBe(0)
    expect(await categoryRows(created.id)).toHaveLength(0)
  })
})
