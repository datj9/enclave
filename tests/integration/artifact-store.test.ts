import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { listOwnedArtifacts } from '@/lib/artifacts/list'
import { DEFAULT_LIST_LIMIT } from '@/lib/artifacts/list-query'
import { PENDING_SWEEP_AFTER_MINUTES, sweepPendingVersions } from '@/jobs/sweep-pending'
import { HttpError } from '@/lib/http'
import { storageKey, versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import type { BundleFile } from '@/lib/bundle/validate'
import {
  BUCKET_NAME,
  createTestOwner,
  createTestStore,
  createUnreachableStore,
  probeServices,
  removeTestOwnerData,
} from './services'

/**
 * The write path against real Postgres and real object storage. Covers the S2 acceptance criteria
 * a mock cannot honestly prove: that bytes land in the bucket with the right `Content-Type`, that
 * a failed upload leaves the version `pending` with `current_version_id` untouched, and that the
 * sweeper reclaims both the row and its objects.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration: database=${database} storage=${storage}. ` +
      'Start them with `docker compose --profile minio up -d` and run `pnpm db:migrate`.',
  )
}

const INDEX_HTML = '<!doctype html><script src=./app.js></script>'
const APP_JS = 'console.log(1)'

function bundle(): BundleFile[] {
  return [
    { path: 'index.html', content: Buffer.from(INDEX_HTML, 'utf8') },
    { path: 'app.js', content: Buffer.from(APP_JS, 'utf8') },
  ]
}

function bundleOf(fileCount: number): BundleFile[] {
  return [
    { path: 'index.html', content: Buffer.from(INDEX_HTML, 'utf8') },
    ...Array.from({ length: fileCount - 1 }, (_unused, index) => ({
      path: `file-${index}.js`,
      content: Buffer.from(`export const n = ${index}`, 'utf8'),
    })),
  ]
}

/** Fails the nth put and records what it managed to write, so a partial upload is observable. */
function storeFailingAt(store: ObjectStore, failingPutNumber: number): ObjectStore {
  let putCount = 0
  return {
    ...store,
    putObject: async (input) => {
      putCount += 1
      if (putCount === failingPutNumber) {
        throw new HttpError('STORAGE_UNAVAILABLE', 'Storage is unavailable, please retry')
      }
      await store.putObject(input)
    },
  }
}

describe.skipIf(!servicesReady)('artifact write path', () => {
  let store: ObjectStore
  let ownerId = ''

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    ownerId = await createTestOwner()
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
  })

  it('writes the bundle to storage and reads the same bytes back', async () => {
    const created = await createArtifactWithBundle(
      { ownerId, title: 'Sales dash', visibility: 'private', files: bundle() },
      store,
    )

    const indexObject = await store.getObject(
      storageKey(created.id, created.versionId, 'index.html'),
    )
    const scriptObject = await store.getObject(storageKey(created.id, created.versionId, 'app.js'))

    expect(indexObject?.body.toString('utf8')).toBe(INDEX_HTML)
    expect(indexObject?.contentType).toBe('text/html')
    expect(scriptObject?.body.toString('utf8')).toBe(APP_JS)
    // §4.4: the type comes from the extension allowlist, never from sniffing the bytes.
    expect(scriptObject?.contentType).toBe('text/javascript')
  })

  it('leaves exactly one artifact row and one ready version, per the worked example', async () => {
    const created = await createArtifactWithBundle(
      { ownerId, title: 'Sales dash', visibility: 'private', files: bundle() },
      store,
    )

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, created.id))

    expect(artifact).toMatchObject({
      title: 'Sales dash',
      slug: 'sales-dash',
      visibility: 'private',
      ownerId,
      currentVersionId: created.versionId,
      deletedAt: null,
    })
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      id: created.versionId,
      versionNo: 1,
      status: 'ready',
      entryPath: 'index.html',
      fileCount: 2,
      totalBytes: INDEX_HTML.length + APP_JS.length,
      createdBy: ownerId,
      generationId: null,
    })
    expect(versions[0]?.manifest).toEqual([
      { path: 'index.html', bytes: 45, content_type: 'text/html', sha256: expect.any(String) },
      { path: 'app.js', bytes: 14, content_type: 'text/javascript', sha256: expect.any(String) },
    ])
    expect(created.viewUrl).toContain(created.id)
  })

  it('an upload failing on file 7 of 10 leaves the version pending and current_version_id NULL', async () => {
    // US-6 AC6 — the atomicity criterion from decision #21.
    const failingStore = storeFailingAt(store, 7)

    await expect(
      createArtifactWithBundle(
        { ownerId, title: 'Half written', visibility: 'private', files: bundleOf(10) },
        failingStore,
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 })

    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifact?.id ?? ''))

    expect(artifact?.currentVersionId).toBeNull()
    expect(versions).toHaveLength(1)
    expect(versions[0]?.status).toBe('pending')

    // Only the first six objects made it, and nothing beyond them was written.
    const written = await store.listKeys(versionPrefix(artifact?.id ?? '', versions[0]?.id ?? ''))
    expect(written).toHaveLength(6)
  })

  it('hides a pending version from the list and shows it once it is ready', async () => {
    const failingStore = storeFailingAt(store, 1)
    await expect(
      createArtifactWithBundle(
        { ownerId, title: 'Never finished', visibility: 'private', files: bundle() },
        failingStore,
      ),
    ).rejects.toBeInstanceOf(HttpError)

    const afterFailure = await listOwnedArtifacts(ownerId, {
      limit: DEFAULT_LIST_LIMIT,
      cursor: undefined,
    })
    expect(afterFailure.items).toEqual([])

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Finished', visibility: 'private', files: bundle() },
      store,
    )

    const afterSuccess = await listOwnedArtifacts(ownerId, {
      limit: DEFAULT_LIST_LIMIT,
      cursor: undefined,
    })
    expect(afterSuccess.items).toHaveLength(1)
    expect(afterSuccess.items[0]).toMatchObject({
      id: created.id,
      title: 'Finished',
      versionId: created.versionId,
      versionNo: 1,
      fileCount: 2,
    })
    expect(afterSuccess.nextCursor).toBeNull()
  })

  it('answers 503 STORAGE_UNAVAILABLE without naming the bucket or a stack', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const failure = await createArtifactWithBundle(
      { ownerId, title: 'Nowhere to write', visibility: 'private', files: bundle() },
      createUnreachableStore(),
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(HttpError)
    const httpError = failure as HttpError
    expect(httpError.code).toBe('STORAGE_UNAVAILABLE')
    expect(httpError.status).toBe(503)
    expect(httpError.message).toBe('Storage is unavailable, please retry')
    expect(httpError.message).not.toContain(BUCKET_NAME)
    expect(httpError.message).not.toContain('127.0.0.1')

    vi.restoreAllMocks()
  })

  it('pages with a keyset cursor and never repeats a row', async () => {
    const created = []
    for (const title of ['first', 'second', 'third']) {
      created.push(
        await createArtifactWithBundle(
          { ownerId, title, visibility: 'private', files: bundle() },
          store,
        ),
      )
    }

    const firstPage = await listOwnedArtifacts(ownerId, { limit: 2, cursor: undefined })
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.nextCursor).not.toBeNull()

    const rest = await listOwnedArtifacts(ownerId, {
      limit: 2,
      cursor: { createdAt: firstPage.items[1]?.createdAt ?? '', id: firstPage.items[1]?.id ?? '' },
    })
    expect(rest.items).toHaveLength(1)
    expect(rest.nextCursor).toBeNull()

    const seen = [...firstPage.items, ...rest.items].map((item) => item.id)
    expect(new Set(seen).size).toBe(3)
    expect(seen).toEqual(expect.arrayContaining(created.map((artifact) => artifact.id)))
  })
})

describe.skipIf(!servicesReady)('sweepPendingVersions', () => {
  let store: ObjectStore
  let ownerId = ''

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    ownerId = await createTestOwner()
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
  })

  async function createStuckPendingVersion(): Promise<{ artifactId: string; versionId: string }> {
    const failingStore = storeFailingAt(store, 2)
    await expect(
      createArtifactWithBundle(
        { ownerId, title: 'Stuck', visibility: 'private', files: bundle() },
        failingStore,
      ),
    ).rejects.toBeInstanceOf(HttpError)

    const [artifact] = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
    const [version] = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifact?.id ?? ''))

    if (artifact === undefined || version === undefined) throw new Error('setup failed')
    return { artifactId: artifact.id, versionId: version.id }
  }

  async function ageVersion(versionId: string, minutes: number): Promise<void> {
    await db
      .update(artifactVersions)
      .set({ createdAt: sql`now() - make_interval(mins => ${minutes})` })
      .where(eq(artifactVersions.id, versionId))
  }

  it('leaves a pending version younger than the cutoff alone', async () => {
    const stuck = await createStuckPendingVersion()

    await sweepPendingVersions(store)

    const survivors = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, stuck.versionId))
    expect(survivors).toHaveLength(1)
  })

  it('deletes a pending version older than the cutoff together with its objects', async () => {
    const stuck = await createStuckPendingVersion()
    await ageVersion(stuck.versionId, PENDING_SWEEP_AFTER_MINUTES + 1)

    const before = await store.listKeys(versionPrefix(stuck.artifactId, stuck.versionId))
    expect(before.length).toBeGreaterThan(0)

    const result = await sweepPendingVersions(store)

    expect(result.sweptVersionCount).toBeGreaterThanOrEqual(1)
    expect(result.failedVersionCount).toBe(0)
    expect(await store.listKeys(versionPrefix(stuck.artifactId, stuck.versionId))).toEqual([])
    const remaining = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, stuck.versionId))
    expect(remaining).toEqual([])
  })

  it('never touches a ready version', async () => {
    const created = await createArtifactWithBundle(
      { ownerId, title: 'Ready and old', visibility: 'private', files: bundle() },
      store,
    )
    await ageVersion(created.versionId, PENDING_SWEEP_AFTER_MINUTES * 10)

    await sweepPendingVersions(store)

    const survivors = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(
        and(eq(artifactVersions.id, created.versionId), eq(artifactVersions.status, 'ready')),
      )
    expect(survivors).toHaveLength(1)
    expect(await store.listKeys(versionPrefix(created.id, created.versionId))).toHaveLength(2)
  })

  it('defers a version whose objects cannot be deleted so the next run retries it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stuck = await createStuckPendingVersion()
    await ageVersion(stuck.versionId, PENDING_SWEEP_AFTER_MINUTES + 1)

    const result = await sweepPendingVersions(createUnreachableStore())

    expect(result.sweptVersionCount).toBe(0)
    expect(result.failedVersionCount).toBeGreaterThanOrEqual(1)
    const stillThere = await db
      .select({ id: artifactVersions.id })
      .from(artifactVersions)
      .where(eq(artifactVersions.id, stuck.versionId))
    expect(stillThere).toHaveLength(1)

    vi.restoreAllMocks()
  })
})
