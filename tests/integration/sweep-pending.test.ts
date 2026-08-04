import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/db'
import { artifactVersions, artifacts, type VersionStatus } from '@/db/schema/artifacts'
import { slugFromTitle } from '@/lib/artifacts/naming'
import { PENDING_SWEEP_AFTER_MINUTES, sweepPendingVersions } from '@/jobs/sweep-pending'
import { storageKey, versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { createTestOwner, createTestStore, probeServices, removeTestOwnerData } from './services'

/**
 * S8 against real Postgres and real object storage: a failed bundle upload leaves objects gone
 * but the `pending` version and its parent `artifacts` row behind. `sweepPendingVersions` reclaims
 * both — the version always, the parent only when the sweep leaves it version-less, non-current
 * and non-trashed (T3, decision #21).
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/sweep-pending: database=${database} storage=${storage}`,
  )
}

const STALE_MINUTES = PENDING_SWEEP_AFTER_MINUTES + 1
const FRESH_MINUTES = 1

let store: ObjectStore
let ownerId = ''

async function insertArtifact(title: string): Promise<string> {
  const [artifact] = await db
    .insert(artifacts)
    .values({ ownerId, title, slug: slugFromTitle(title), visibility: 'private' })
    .returning({ id: artifacts.id })

  if (artifact === undefined) throw new Error(`could not create artifact ${title}`)
  return artifact.id
}

async function insertVersion(
  artifactId: string,
  versionNo: number,
  status: VersionStatus,
): Promise<string> {
  const [version] = await db
    .insert(artifactVersions)
    .values({
      artifactId,
      versionNo,
      status,
      manifest: [],
      totalBytes: 0,
      fileCount: 0,
      createdBy: ownerId,
    })
    .returning({ id: artifactVersions.id })

  if (version === undefined) throw new Error('could not create artifact version')

  await store.putObject({
    key: storageKey(artifactId, version.id, 'index.html'),
    body: Buffer.from('<!doctype html><p>stale', 'utf8'),
    contentType: 'text/html',
  })

  return version.id
}

/** Backdates `created_at` so the sweep's `now() - make_interval(...)` cutoff judges it stale. */
async function ageVersion(versionId: string, minutes: number): Promise<void> {
  await db
    .update(artifactVersions)
    .set({ createdAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(artifactVersions.id, versionId))
}

async function markCurrent(artifactId: string, versionId: string): Promise<void> {
  await db.update(artifacts).set({ currentVersionId: versionId }).where(eq(artifacts.id, artifactId))
}

async function markTrashed(artifactId: string): Promise<void> {
  await db.update(artifacts).set({ deletedAt: new Date() }).where(eq(artifacts.id, artifactId))
}

async function artifactRow(artifactId: string) {
  const [row] = await db
    .select({ deletedAt: artifacts.deletedAt })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1)
  return row
}

async function versionCount(artifactId: string): Promise<number> {
  const rows = await db
    .select({ id: artifactVersions.id })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
  return rows.length
}

describe.skipIf(!servicesReady)('T3 orphan-reclaiming sweep', () => {
  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
    ownerId = await createTestOwner()
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
  })

  it('reclaims an artifact left version-less by a failed upload', async () => {
    const artifactId = await insertArtifact('Quarterly deck')
    const versionId = await insertVersion(artifactId, 1, 'pending')
    await ageVersion(versionId, STALE_MINUTES)

    const result = await sweepPendingVersions(store)

    expect(result).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 1 })
    expect(await artifactRow(artifactId)).toBeUndefined()
    expect(await versionCount(artifactId)).toBe(0)
    expect(await store.listKeys(versionPrefix(artifactId, versionId))).toHaveLength(0)
  })

  it('sweeps a stale pending version but keeps the artifact alive behind its ready current version', async () => {
    const artifactId = await insertArtifact('Has a live version')
    const readyVersionId = await insertVersion(artifactId, 1, 'ready')
    await markCurrent(artifactId, readyVersionId)
    const staleVersionId = await insertVersion(artifactId, 2, 'pending')
    await ageVersion(staleVersionId, STALE_MINUTES)

    const result = await sweepPendingVersions(store)

    expect(result).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 0 })
    expect(await artifactRow(artifactId)).toBeDefined()
    expect(await versionCount(artifactId)).toBe(1)
  })

  it('sweeps a stale pending version but leaves a trashed artifact for the purge job', async () => {
    const artifactId = await insertArtifact('Already in the trash')
    await markTrashed(artifactId)
    const versionId = await insertVersion(artifactId, 1, 'pending')
    await ageVersion(versionId, STALE_MINUTES)

    const result = await sweepPendingVersions(store)

    expect(result).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 0 })
    expect((await artifactRow(artifactId))?.deletedAt).not.toBeNull()
    expect(await versionCount(artifactId)).toBe(0)
  })

  it('removes the artifact only once both stale pending siblings are gone', async () => {
    const artifactId = await insertArtifact('Two dead uploads')
    const firstVersionId = await insertVersion(artifactId, 1, 'pending')
    const secondVersionId = await insertVersion(artifactId, 2, 'pending')
    await ageVersion(firstVersionId, STALE_MINUTES)
    await ageVersion(secondVersionId, FRESH_MINUTES)

    const firstSweep = await sweepPendingVersions(store)
    expect(firstSweep).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 0 })
    expect(await artifactRow(artifactId)).toBeDefined()
    expect(await versionCount(artifactId)).toBe(1)

    await ageVersion(secondVersionId, STALE_MINUTES)

    const secondSweep = await sweepPendingVersions(store)
    expect(secondSweep).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 1 })
    expect(await artifactRow(artifactId)).toBeUndefined()
    expect(await versionCount(artifactId)).toBe(0)
  })
})
