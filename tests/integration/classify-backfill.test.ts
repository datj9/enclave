import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { auditLog } from '@/db/schema/audit-log'
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

// Category names are globally unique, and `listCategories` is instance-wide, so a name shared
// with another test file both fails this file's setup and lets its slug match the wrong id.
const DOCS_NAME = 'Backfill Docs'
const DOCS_REPLY = '["backfill-docs"]'

function bundle(marker: string): BundleFile[] {
  return [{ path: 'index.html', content: Buffer.from(`<!doctype html><p>${marker}`, 'utf8') }]
}

function categoryRows(artifactId: string) {
  return db
    .select({ categoryId: artifactCategories.categoryId })
    .from(artifactCategories)
    .where(eq(artifactCategories.artifactId, artifactId))
}

/** Live, model-sourced and untagged: exactly what the backfill is meant to pick up. */
async function createEligibleArtifact(title: string): Promise<string> {
  const created = await createArtifactWithBundle(
    { ownerId, title, visibility: 'private', files: bundle(title) },
    store,
  )
  await db.delete(artifactCategories).where(eq(artifactCategories.artifactId, created.id))
  await db.update(artifacts).set({ categorySource: 'model' }).where(eq(artifacts.id, created.id))
  return created.id
}

/** Stands in for a transient storage fault on one row: a network blip, a throttle, an expiry. */
function storeFailingOn(artifactId: string): ObjectStore {
  return {
    ...store,
    getObject: (key: string) =>
      key.startsWith(`artifacts/${artifactId}/`)
        ? Promise.reject(new Error('simulated storage outage'))
        : store.getObject(key),
  }
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
      name: DOCS_NAME,
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
    mocks.completion = DOCS_REPLY
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
    mocks.completion = DOCS_REPLY
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
    mocks.completion = DOCS_REPLY

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
    mocks.completion = DOCS_REPLY

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
    mocks.completion = DOCS_REPLY
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
    mocks.completion = DOCS_REPLY
    mocks.calls = 0

    const result = await backfillArtifactCategories(store, { ownerId })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 0, skippedCount: 1 })
    expect(mocks.calls).toBe(0)
    expect(await categoryRows(created.id)).toHaveLength(0)
  })
  it('reaches the same end state when the backfill runs twice', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY

    const artifactId = await createEligibleArtifact('Rerun safety')
    mocks.calls = 0

    const firstRun = await backfillArtifactCategories(store, { ownerId })
    const tagsAfterFirstRun = (await categoryRows(artifactId)).map((row) => row.categoryId)
    const secondRun = await backfillArtifactCategories(store, { ownerId })

    expect(firstRun).toEqual({ eligibleCount: 1, classifiedCount: 1, skippedCount: 0 })
    expect(secondRun).toEqual({ eligibleCount: 0, classifiedCount: 0, skippedCount: 0 })
    expect(tagsAfterFirstRun).toEqual([docsId])
    expect((await categoryRows(artifactId)).map((row) => row.categoryId)).toEqual(tagsAfterFirstRun)
    expect(mocks.calls).toBe(1)
  })

  it('keeps classifying the other artifacts when one entry read throws', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY

    const firstId = await createEligibleArtifact('Partial failure first')
    const failingId = await createEligibleArtifact('Partial failure middle')
    const lastId = await createEligibleArtifact('Partial failure last')
    mocks.calls = 0

    const result = await backfillArtifactCategories(storeFailingOn(failingId), { ownerId })

    expect(result).toEqual({ eligibleCount: 3, classifiedCount: 2, skippedCount: 1 })
    expect(mocks.calls).toBe(2)
    expect((await categoryRows(firstId)).map((row) => row.categoryId)).toEqual([docsId])
    expect((await categoryRows(lastId)).map((row) => row.categoryId)).toEqual([docsId])
    expect(await categoryRows(failingId)).toHaveLength(0)
  })

  it('does not report an artifact as classified when the classifier writes nothing', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = null

    const artifactId = await createEligibleArtifact('Classifier declined')
    mocks.calls = 0

    const result = await backfillArtifactCategories(store, { ownerId })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 0, skippedCount: 1 })
    expect(mocks.calls).toBe(1)
    expect(await categoryRows(artifactId)).toHaveLength(0)
  })

  it('writes an artifact.auto_tag audit row for the artifact it classifies', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    // Declined on upload, so `audit_log` (append-only) holds no row but the backfill's.
    mocks.completion = null
    const artifactId = await createEligibleArtifact('Audited backfill')

    mocks.completion = DOCS_REPLY
    await backfillArtifactCategories(store, { ownerId })

    const rows = await db
      .select({ actorUserId: auditLog.actorUserId, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'artifact.auto_tag'), eq(auditLog.artifactId, artifactId)))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actorUserId).toBeNull()
    expect(rows[0]?.metadata).toEqual({ categoryIds: [docsId], categorySource: 'model' })
  })

  // Documented in docs/self-hosting.md: a no-category match is a real classification, but it
  // leaves the row matching the eligibility predicate, so every later run pays for it again.
  it('reports a no-category match as classified and leaves it eligible for the next run', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = '[]'

    const artifactId = await createEligibleArtifact('Matched no category')
    mocks.calls = 0

    const firstRun = await backfillArtifactCategories(store, { ownerId })
    const secondRun = await backfillArtifactCategories(store, { ownerId })

    expect(firstRun).toEqual({ eligibleCount: 1, classifiedCount: 1, skippedCount: 0 })
    expect(secondRun).toEqual({ eligibleCount: 1, classifiedCount: 1, skippedCount: 0 })
    expect(await categoryRows(artifactId)).toHaveLength(0)
    expect(mocks.calls).toBe(2)
  })

  it('classifies no more than the requested limit in one run', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY

    await createEligibleArtifact('Limit first')
    await createEligibleArtifact('Limit second')
    mocks.calls = 0

    const result = await backfillArtifactCategories(store, { ownerId, limit: 1 })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 1, skippedCount: 0 })
    expect(mocks.calls).toBe(1)
  })

  it('reports a dry run without calling the provider or writing tags', async () => {
    await setAutoCategorizeEnabled(true, adminId)
    mocks.completion = DOCS_REPLY

    const artifactId = await createEligibleArtifact('Dry run')
    mocks.calls = 0

    const result = await backfillArtifactCategories(store, { ownerId, isDryRun: true })

    expect(result).toEqual({ eligibleCount: 1, classifiedCount: 0, skippedCount: 0 })
    expect(mocks.calls).toBe(0)
    expect(await categoryRows(artifactId)).toHaveLength(0)
  })
})
