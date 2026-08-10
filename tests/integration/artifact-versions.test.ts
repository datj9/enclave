import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { auditLog } from '@/db/schema/audit-log'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { users } from '@/db/schema/users'
import type { BundleFile } from '@/lib/bundle/validate'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { artifactViewUrl } from '@/lib/artifacts/naming'
import { appendVersion, type AppendedVersion } from '@/lib/artifacts/versions'
import { HttpError } from '@/lib/http'
import { artifactPrefix, versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { createTestOwner, createTestStore, probeServices, removeTestOwnerData } from './services'

/**
 * The S15 append path against real Postgres and real object storage: the guard refusal, the
 * non-owner and trashed 404s, the mid-upload failure that must leave `current_version_id`
 * untouched, the 23505 backstop, and the `version.create` audit row.
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

/** Any call at all fails the test: the proof that a refused append uploaded nothing. */
const refusingStore: ObjectStore = {
  ensureBucket: () => Promise.reject(new Error('storage must not be touched')),
  putObject: () => Promise.reject(new Error('storage must not be touched')),
  getObject: () => Promise.reject(new Error('storage must not be touched')),
  getObjectStream: () => Promise.reject(new Error('storage must not be touched')),
  presignGetUrl: () => Promise.reject(new Error('storage must not be touched')),
  listKeys: () => Promise.reject(new Error('storage must not be touched')),
  deletePrefix: () => Promise.reject(new Error('storage must not be touched')),
}

const STRANGER_EMAIL = 'stranger-owner@example.test'
/** Not the shared `TEST_OWNER_EMAIL`: this file runs in parallel with `artifact-store.test.ts`,
 *  which deletes that row out from under our `created_by` rows. */
const VERSIONS_OWNER_EMAIL = 'integration-versions-owner@example.test'

async function createStrangerOwner(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: STRANGER_EMAIL, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (row === undefined) throw new Error('could not create the stranger owner')
  return row.id
}

describe.skipIf(!servicesReady)('appendVersion', () => {
  let store: ObjectStore
  let ownerId = ''

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    ownerId = await createTestOwner(VERSIONS_OWNER_EMAIL)
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (ownerId === '') return

    // FK order: versions first (they reference the artifact and the user), then the artifact,
    // then the users. A failed test must never leave rows behind that trip another file's
    // `createTestOwner` on the `artifact_versions_created_by_users_id_fk` delete.
    const owned = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
    for (const artifact of owned) await store.deletePrefix(artifactPrefix(artifact.id))

    await db.delete(artifactVersions).where(eq(artifactVersions.createdBy, ownerId))
    await db.delete(artifacts).where(eq(artifacts.ownerId, ownerId))
    await db.delete(users).where(eq(users.id, ownerId))
    await db.delete(users).where(eq(users.email, STRANGER_EMAIL))
  })

  async function createFirstVersion(): Promise<{ readonly id: string; readonly versionId: string }> {
    return await createArtifactWithBundle(
      { ownerId, title: 'Sales dash', visibility: 'private', files: bundle() },
      store,
    )
  }

  it('appends versionNo 2, marks it ready, and repoints current_version_id', async () => {
    const created = await createFirstVersion()

    const appended = await appendVersion(
      { artifactId: created.id, ownerId, files: bundle(), actorIp: '203.0.113.7' },
      store,
    )

    expect(appended).toEqual({
      versionId: expect.any(String) as string,
      versionNo: 2,
      viewUrl: artifactViewUrl(created.id),
    })

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, created.id))
      .orderBy(artifactVersions.versionNo)

    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({ versionNo: 1, status: 'ready' })
    expect(versions[1]).toMatchObject({ id: appended.versionId, versionNo: 2, status: 'ready' })
    expect(artifact?.currentVersionId).toBe(appended.versionId)
  })

  it('expectedVersionNo mismatch throws VERSION_CONFLICT, writes no version and uploads nothing', async () => {
    const created = await createFirstVersion()
    const putSpy = vi.spyOn(refusingStore, 'putObject')

    const failure = await appendVersion(
      { artifactId: created.id, ownerId, files: bundle(), expectedVersionNo: 2 },
      refusingStore,
    ).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 })
    expect((failure as HttpError).details).toEqual({
      expectedVersionNo: 2,
      currentVersionNo: 1,
    })
    expect(putSpy).not.toHaveBeenCalled()

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, created.id))
    expect(versions).toHaveLength(1)
    expect(versions[0]?.versionNo).toBe(1)
  })

  it('appends unconditionally when expectedVersionNo is absent, even after the server moved on', async () => {
    const created = await createFirstVersion()

    const second = await appendVersion(
      { artifactId: created.id, ownerId, files: bundle() },
      store,
    )
    const third = await appendVersion(
      { artifactId: created.id, ownerId, files: bundle() },
      store,
    )

    expect(second.versionNo).toBe(2)
    expect(third.versionNo).toBe(3)

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.currentVersionId).toBe(third.versionId)

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, created.id))
    expect(versions).toHaveLength(3)
  })

  it('refuses a non-owner with 404, never 403', async () => {
    const created = await createFirstVersion()
    const strangerId = await createStrangerOwner()

    try {
      const failure = await appendVersion(
        { artifactId: created.id, ownerId: strangerId, files: bundle() },
        store,
      ).catch((thrown: unknown) => thrown)

      expect(failure).toBeInstanceOf(HttpError)
      expect(failure).toMatchObject({ code: 'NOT_FOUND', status: 404 })
    } finally {
      await db.delete(users).where(eq(users.email, STRANGER_EMAIL))
    }
  })

  it('refuses a soft-deleted artifact with 404', async () => {
    const created = await createFirstVersion()
    await db
      .update(artifacts)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(artifacts.id, created.id))

    const failure = await appendVersion(
      { artifactId: created.id, ownerId, files: bundle() },
      store,
    ).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('leaves the new version pending and current_version_id untouched when storage fails mid-upload', async () => {
    const created = await createFirstVersion()
    const failingStore = storeFailingAt(store, 2)

    const failure = await appendVersion(
      { artifactId: created.id, ownerId, files: bundleOf(3) },
      failingStore,
    ).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 })

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.currentVersionId).toBe(created.versionId)

    const [pending] = await db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.artifactId, created.id),
          eq(artifactVersions.versionNo, 2),
        ),
      )
    expect(pending).toMatchObject({ versionNo: 2, status: 'pending' })

    // Only the first object made it; nothing beyond the partial prefix was written.
    const written = await store.listKeys(versionPrefix(created.id, pending?.id ?? ''))
    expect(written).toHaveLength(1)
  })

  it('serialises two concurrent appends: one wins, the other gets VERSION_CONFLICT', async () => {
    const created = await createFirstVersion()

    // Both take `SELECT ... FOR UPDATE` on the artifact row, so they serialize on that lock
    // instead of racing the unique index: the loser re-reads the bumped version number and the
    // guard refuses it.
    const results = await Promise.allSettled([
      appendVersion({ artifactId: created.id, ownerId, files: bundle(), expectedVersionNo: 1 }, store),
      appendVersion({ artifactId: created.id, ownerId, files: bundle(), expectedVersionNo: 1 }, store),
    ])

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<AppendedVersion> => result.status === 'fulfilled',
    )
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    const winner = fulfilled[0]?.value
    expect(winner).toBeDefined()
    expect(winner?.versionNo).toBe(2)

    const loser = rejected[0]?.reason
    expect(loser).toBeInstanceOf(HttpError)
    expect(loser).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 })

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.id, created.id))
    expect(artifact?.currentVersionId).toBe(winner?.versionId)

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, created.id))
    expect(versions).toHaveLength(2)
  })

  it('writes exactly one version.create audit row per append, carrying actorIp', async () => {
    const created = await createFirstVersion()

    const appended = await appendVersion(
      { artifactId: created.id, ownerId, files: bundle(), actorIp: '203.0.113.7' },
      store,
    )

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'version.create'), eq(auditLog.versionId, appended.versionId)),
      )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actorUserId: ownerId,
      actorIp: '203.0.113.7',
      artifactId: created.id,
      versionId: appended.versionId,
    })
    expect(rows[0]?.metadata).toEqual({ versionNo: 2, fileCount: 2 })
  })
})
