import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DELETE as deleteArtifactRoute } from '@app/api/v1/artifacts/[id]/route'
import { POST as restoreArtifactRoute } from '@app/api/v1/artifacts/[id]/restore/route'
import { db } from '@/db'
import { apiTokens } from '@/db/schema/api-tokens'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { auditLog, type AuditAction } from '@/db/schema/audit-log'
import { shareLinks } from '@/db/schema/share-links'
import { users } from '@/db/schema/users'
import { purgeTrashedArtifacts } from '@/jobs/purge-trash'
import { authorizeArtifactRead, shareViewerRef, userViewerRef } from '@/lib/artifacts/authorize'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { listOwnedArtifacts } from '@/lib/artifacts/list'
import { DEFAULT_LIST_LIMIT } from '@/lib/artifacts/list-query'
import { listTrashedArtifacts } from '@/lib/artifacts/trash'
import { restoreArtifact, softDeleteArtifact } from '@/lib/artifacts/update'
import { createApiToken } from '@/lib/auth/bearer'
import { epochToDate } from '@/lib/shares/clock'
import { createShareLink, revokeShareLink } from '@/lib/shares/manage'
import { artifactPrefix, type ObjectStore } from '@/lib/storage/object-store'
import type { BundleFile } from '@/lib/bundle/validate'
import { createTestStore, createUnreachableStore, probeServices } from './services'

/**
 * S9 against real Postgres and real object storage. The parts a mock cannot prove honestly: that
 * one transaction takes the artifact and its links together, that the retention window is judged
 * on the database clock, that a purge really removes the bytes, and that the audit trail outlives
 * everything it names (§8, A.12.4.1).
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/trash-purge: database=${database} storage=${storage}`,
  )
}

const ALICE_EMAIL = 'trash-alice@example.test'
const BOB_EMAIL = 'trash-bob@example.test'
const ADMIN_EMAIL = 'trash-admin@example.test'

const RETENTION_DAYS = 30
const WITHIN_WINDOW_DAYS = 29
const PAST_WINDOW_DAYS = 31

const ARTIFACTS_URL = 'http://app.example.com/api/v1/artifacts'

let store: ObjectStore
let aliceId = ''
let bobId = ''
let adminId = ''
let aliceToken = ''
let bobToken = ''
let adminToken = ''

function bundle(marker: string): BundleFile[] {
  return [
    { path: 'index.html', content: Buffer.from(`<!doctype html><p>${marker}`, 'utf8') },
    { path: 'app.js', content: Buffer.from(`export const marker = '${marker}'`, 'utf8') },
  ]
}

async function removeUserAndOwnedRows(userId: string): Promise<void> {
  const owned = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.ownerId, userId))
  for (const artifact of owned) {
    await store.deletePrefix(artifactPrefix(artifact.id))
  }

  await db.delete(apiTokens).where(eq(apiTokens.userId, userId))
  await db.delete(shareLinks).where(eq(shareLinks.createdBy, userId))
  await db.delete(artifacts).where(eq(artifacts.ownerId, userId))
  await db.delete(users).where(eq(users.id, userId))
}

async function createUser(email: string, role: 'admin' | 'member'): Promise<string> {
  const stale = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  for (const user of stale) {
    await removeUserAndOwnedRows(user.id)
  }

  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: null, role, isActive: true })
    .returning({ id: users.id })

  if (user === undefined) throw new Error(`could not create ${email}`)
  return user.id
}

async function createOwnedArtifact(title: string) {
  return await createArtifactWithBundle(
    { ownerId: aliceId, title, visibility: 'private', files: bundle(title) },
    store,
  )
}

/** Moves `deleted_at` into the past in Postgres, so the window is still judged by the database. */
async function ageDeletion(artifactId: string, days: number): Promise<void> {
  await db
    .update(artifacts)
    .set({ deletedAt: sql`now() - make_interval(days => ${days})` })
    .where(eq(artifacts.id, artifactId))
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

async function auditRowsFor(artifactId: string, action: AuditAction) {
  return await db
    .select({ id: auditLog.id, artifactId: auditLog.artifactId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(eq(auditLog.artifactId, artifactId), eq(auditLog.action, action)))
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) }
}

function deleteRequest(token: string, artifactId: string): Request {
  return new Request(`${ARTIFACTS_URL}/${artifactId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  })
}

function restoreRequest(token: string, artifactId: string): Request {
  return new Request(`${ARTIFACTS_URL}/${artifactId}/restore`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
}

describe.skipIf(!servicesReady)('S9 delete, restore and purge', () => {
  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()

    aliceId = await createUser(ALICE_EMAIL, 'member')
    bobId = await createUser(BOB_EMAIL, 'member')
    adminId = await createUser(ADMIN_EMAIL, 'admin')

    aliceToken = (
      await createApiToken({ userId: aliceId, name: 'trash-alice', scopes: ['artifacts:write'] })
    ).plaintext
    bobToken = (
      await createApiToken({ userId: bobId, name: 'trash-bob', scopes: ['artifacts:write'] })
    ).plaintext
    adminToken = (
      await createApiToken({ userId: adminId, name: 'trash-admin', scopes: ['artifacts:write'] })
    ).plaintext
  })

  afterAll(async () => {
    for (const id of [aliceId, bobId, adminId].filter((id) => id !== '')) {
      await removeUserAndOwnedRows(id)
    }
  })

  describe('DELETE /api/v1/artifacts/{id}', () => {
    it('204s, leaves the list, and 404s for the owner as well as the link holder', async () => {
      const created = await createOwnedArtifact('Delete removes every read path')
      const share = await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })

      const response = await deleteArtifactRoute(
        deleteRequest(aliceToken, created.id),
        routeContext(created.id),
      )

      expect(response.status).toBe(204)
      const listed = await listOwnedArtifacts(aliceId, {
        limit: DEFAULT_LIST_LIMIT,
        cursor: undefined,
      })
      expect(listed.items.map((item) => item.id)).not.toContain(created.id)
      expect(await authorizeArtifactRead(created.id, userViewerRef(aliceId))).toBeNull()
      expect(await authorizeArtifactRead(created.id, shareViewerRef(share.shareId))).toBeNull()
    })

    it('revokes every live link in the same transaction that stamps deleted_at', async () => {
      const created = await createOwnedArtifact('Delete kills the links')
      const first = await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })
      const second = await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })

      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      const links = await db
        .select({ id: shareLinks.id, revokedAt: shareLinks.revokedAt })
        .from(shareLinks)
        .where(eq(shareLinks.artifactId, created.id))

      expect(links.map((link) => link.id).sort()).toEqual([first.shareId, second.shareId].sort())
      expect(links.every((link) => link.revokedAt !== null)).toBe(true)
    })

    it('keeps an already-revoked link on its original timestamp', async () => {
      const created = await createOwnedArtifact('Delete respects an earlier revoke')
      const share = await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })
      await revokeShareLink(share.shareId, userViewerRef(aliceId))

      const [before] = await db
        .select({ revokedAt: shareLinks.revokedAt })
        .from(shareLinks)
        .where(eq(shareLinks.id, share.shareId))

      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      const [after] = await db
        .select({ revokedAt: shareLinks.revokedAt })
        .from(shareLinks)
        .where(eq(shareLinks.id, share.shareId))

      expect(after?.revokedAt).toEqual(before?.revokedAt)
    })

    it('writes one artifact.delete row naming how many links it killed', async () => {
      const created = await createOwnedArtifact('Delete is audited')
      await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })

      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      const rows = await auditRowsFor(created.id, 'artifact.delete')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.metadata).toMatchObject({ visibility: 'private', revokedShareLinks: 1 })
    })

    it('404s a second delete, because the trash is unreadable to the owner too', async () => {
      const created = await createOwnedArtifact('Delete is not idempotent by design')

      const first = await deleteArtifactRoute(
        deleteRequest(aliceToken, created.id),
        routeContext(created.id),
      )
      const second = await deleteArtifactRoute(
        deleteRequest(aliceToken, created.id),
        routeContext(created.id),
      )

      expect([first.status, second.status]).toEqual([204, 404])
    })

    it('404s another member and 404s an admin (branch 5), leaving the artifact alive', async () => {
      const created = await createOwnedArtifact('Only the owner deletes')

      const asBob = await deleteArtifactRoute(
        deleteRequest(bobToken, created.id),
        routeContext(created.id),
      )
      const asAdmin = await deleteArtifactRoute(
        deleteRequest(adminToken, created.id),
        routeContext(created.id),
      )

      expect([asBob.status, asAdmin.status]).toEqual([404, 404])
      expect((await artifactRow(created.id))?.deletedAt).toBeNull()
    })
  })

  describe('POST /api/v1/artifacts/{id}/restore', () => {
    it(`restores at day ${WITHIN_WINDOW_DAYS} with every version intact`, async () => {
      const created = await createOwnedArtifact('Restored inside the window')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, WITHIN_WINDOW_DAYS)

      const response = await restoreArtifactRoute(
        restoreRequest(aliceToken, created.id),
        routeContext(created.id),
      )

      expect(response.status).toBe(200)
      expect((await artifactRow(created.id))?.deletedAt).toBeNull()
      expect(await versionCount(created.id)).toBe(1)
      expect(await authorizeArtifactRead(created.id, userViewerRef(aliceId))).not.toBeNull()
    })

    it(`404s at day ${PAST_WINDOW_DAYS} and leaves it in the trash`, async () => {
      const created = await createOwnedArtifact('Restored too late')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, PAST_WINDOW_DAYS)

      const response = await restoreArtifactRoute(
        restoreRequest(aliceToken, created.id),
        routeContext(created.id),
      )

      expect(response.status).toBe(404)
      expect((await artifactRow(created.id))?.deletedAt).not.toBeNull()
    })

    it('does not un-revoke the share links it killed', async () => {
      const created = await createOwnedArtifact('Restore leaves links dead')
      const share = await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })

      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await restoreArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      const [link] = await db
        .select({ revokedAt: shareLinks.revokedAt })
        .from(shareLinks)
        .where(eq(shareLinks.id, share.shareId))

      expect(link?.revokedAt).not.toBeNull()
      expect(await authorizeArtifactRead(created.id, shareViewerRef(share.shareId))).toBeNull()
    })

    it('writes one artifact.restore row', async () => {
      const created = await createOwnedArtifact('Restore is audited')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await restoreArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      expect(await auditRowsFor(created.id, 'artifact.restore')).toHaveLength(1)
    })

    it('404s another member and 404s an admin', async () => {
      const created = await createOwnedArtifact('Only the owner restores')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      const asBob = await restoreArtifactRoute(
        restoreRequest(bobToken, created.id),
        routeContext(created.id),
      )
      const asAdmin = await restoreArtifactRoute(
        restoreRequest(adminToken, created.id),
        routeContext(created.id),
      )

      expect([asBob.status, asAdmin.status]).toEqual([404, 404])
      expect((await artifactRow(created.id))?.deletedAt).not.toBeNull()
    })

    it('404s an artifact that was never deleted', async () => {
      const created = await createOwnedArtifact('Nothing to restore')

      const response = await restoreArtifactRoute(
        restoreRequest(aliceToken, created.id),
        routeContext(created.id),
      )

      expect(response.status).toBe(404)
    })
  })

  describe('the trash listing', () => {
    it('shows a fresh deletion with the full window left', async () => {
      const created = await createOwnedArtifact('Fresh in the trash')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })

      const { items: listed } = await listTrashedArtifacts(
        aliceId,
        { limit: DEFAULT_LIST_LIMIT, cursor: undefined },
        RETENTION_DAYS,
      )
      const row = listed.find((item) => item.id === created.id)

      expect(row?.title).toBe('Fresh in the trash')
      expect(row?.daysRemaining).toBe(RETENTION_DAYS)
    })

    it(`counts down to ${RETENTION_DAYS - WITHIN_WINDOW_DAYS} at day ${WITHIN_WINDOW_DAYS} and floors at 0 past the window`, async () => {
      const nearlyGone = await createOwnedArtifact('Nearly gone')
      const overdue = await createOwnedArtifact('Overdue')
      await softDeleteArtifact({ artifactId: nearlyGone.id, viewerRef: userViewerRef(aliceId) })
      await softDeleteArtifact({ artifactId: overdue.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(nearlyGone.id, WITHIN_WINDOW_DAYS)
      await ageDeletion(overdue.id, PAST_WINDOW_DAYS)

      const { items: listed } = await listTrashedArtifacts(
        aliceId,
        { limit: DEFAULT_LIST_LIMIT, cursor: undefined },
        RETENTION_DAYS,
      )

      expect(listed.find((item) => item.id === nearlyGone.id)?.daysRemaining).toBe(
        RETENTION_DAYS - WITHIN_WINDOW_DAYS,
      )
      expect(listed.find((item) => item.id === overdue.id)?.daysRemaining).toBe(0)
    })

    it('never shows a live artifact, nor another owner anything', async () => {
      const live = await createOwnedArtifact('Still live')
      const deleted = await createOwnedArtifact('In the trash')
      await softDeleteArtifact({ artifactId: deleted.id, viewerRef: userViewerRef(aliceId) })

      const { items: mine } = await listTrashedArtifacts(
        aliceId,
        { limit: DEFAULT_LIST_LIMIT, cursor: undefined },
        RETENTION_DAYS,
      )
      const { items: bobs } = await listTrashedArtifacts(
        bobId,
        { limit: DEFAULT_LIST_LIMIT, cursor: undefined },
        RETENTION_DAYS,
      )

      expect(mine.map((item) => item.id)).toContain(deleted.id)
      expect(mine.map((item) => item.id)).not.toContain(live.id)
      expect(bobs.map((item) => item.id)).not.toContain(deleted.id)
    })
  })

  describe('the purge job', () => {
    it('leaves an artifact still inside its window alone', async () => {
      const created = await createOwnedArtifact('Not due yet')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, WITHIN_WINDOW_DAYS)

      await purgeTrashedArtifacts(store, RETENTION_DAYS)

      expect(await artifactRow(created.id)).toBeDefined()
      expect(await versionCount(created.id)).toBe(1)
      expect(await store.listKeys(artifactPrefix(created.id))).toHaveLength(2)
    })

    it('erases the objects, the versions and the artifact once it is due', async () => {
      const created = await createOwnedArtifact('Purged for good')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, PAST_WINDOW_DAYS)
      expect(await store.listKeys(artifactPrefix(created.id))).toHaveLength(2)

      const result = await purgeTrashedArtifacts(store, RETENTION_DAYS)

      expect(result.purgedArtifactCount).toBeGreaterThanOrEqual(1)
      expect(result.failedArtifactCount).toBe(0)
      expect(await artifactRow(created.id)).toBeUndefined()
      expect(await versionCount(created.id)).toBe(0)
      expect(await store.listKeys(artifactPrefix(created.id))).toHaveLength(0)
    })

    it('keeps the audit trail, artifact_id and all, after the rows are gone', async () => {
      const created = await createOwnedArtifact('Audited beyond the grave')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, PAST_WINDOW_DAYS)

      await purgeTrashedArtifacts(store, RETENTION_DAYS)

      expect(await artifactRow(created.id)).toBeUndefined()
      // The reason `audit_log` carries no foreign keys: a cascade here would erase the history.
      expect(await auditRowsFor(created.id, 'artifact.create')).toHaveLength(1)
      expect(await auditRowsFor(created.id, 'artifact.delete')).toHaveLength(1)
      const purged = await auditRowsFor(created.id, 'artifact.purge')
      expect(purged).toHaveLength(1)
      expect(purged[0]?.artifactId).toBe(created.id)
    })

    it('is a no-op the second time over the same artifact, not an error', async () => {
      const created = await createOwnedArtifact('Purged exactly once')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, PAST_WINDOW_DAYS)

      await purgeTrashedArtifacts(store, RETENTION_DAYS)
      const second = await purgeTrashedArtifacts(store, RETENTION_DAYS)

      expect(second.failedArtifactCount).toBe(0)
      expect(await artifactRow(created.id)).toBeUndefined()
      // A second purge row would mean the job had re-processed an artifact it already removed.
      expect(await auditRowsFor(created.id, 'artifact.purge')).toHaveLength(1)
    })

    it('defers to the next run when the object delete fails, keeping the rows', async () => {
      const created = await createOwnedArtifact('Storage is down')
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, PAST_WINDOW_DAYS)

      const failed = await purgeTrashedArtifacts(createUnreachableStore(), RETENTION_DAYS)

      expect(failed.failedArtifactCount).toBeGreaterThanOrEqual(1)
      expect(failed.purgedArtifactCount).toBe(0)
      expect(await artifactRow(created.id)).toBeDefined()
      expect(await versionCount(created.id)).toBe(1)
      expect(await auditRowsFor(created.id, 'artifact.purge')).toHaveLength(0)

      // The retry: the same artifact is still due, and a reachable store finishes the job.
      const retried = await purgeTrashedArtifacts(store, RETENTION_DAYS)
      expect(retried.purgedArtifactCount).toBeGreaterThanOrEqual(1)
      expect(await artifactRow(created.id)).toBeUndefined()
      expect(await store.listKeys(artifactPrefix(created.id))).toHaveLength(0)
    })

    it('404s a share link pointing at a purged version (§7)', async () => {
      const created = await createOwnedArtifact('Shared then purged')
      const share = await createShareLink({
        artifactId: created.id,
        versionId: created.versionId,
        viewerRef: userViewerRef(aliceId),
      })
      await softDeleteArtifact({ artifactId: created.id, viewerRef: userViewerRef(aliceId) })
      await ageDeletion(created.id, PAST_WINDOW_DAYS)

      await purgeTrashedArtifacts(store, RETENTION_DAYS)

      expect(await authorizeArtifactRead(created.id, shareViewerRef(share.shareId))).toBeNull()
    })
  })

  describe('the retention window is an exact duration, not calendar days (TASK-6)', () => {
    it('an hour-field interval stays exact across a DST transition; a day-field interval does not', async () => {
      // Literal instants rather than `now()`, so the result never depends on the date the suite
      // runs on. Confirmed by hand with `psql` before this fix (`set local timezone =
      // 'America/New_York'` then the same two expressions): withDays read 2026-11-24T21:00:00.000Z
      // (an hour late, across the Nov 1 DST fall-back) and withHours read 2026-11-24T20:00:00.000Z.
      const [row] = await db.transaction(async (transaction) => {
        await transaction.execute(sql`set local timezone = 'America/New_York'`)
        // Epoch, not the driver's text form of timestamptz: `new Date(pg text)` accepting
        // `2026-11-24 16:00:00-05` is luck, not a contract (src/lib/shares/clock.ts:7-10).
        return await transaction.execute<{ withDays: string | number; withHours: string | number }>(
          sql`
          select
            extract(epoch from (timestamptz '2026-10-25T20:00:00Z' + make_interval(days => 30))) as "withDays",
            extract(epoch from (timestamptz '2026-10-25T20:00:00Z' + make_interval(hours => 720))) as "withHours"
        `,
        )
      })

      expect(row === undefined ? undefined : epochToDate(row.withDays).toISOString()).toBe(
        '2026-11-24T21:00:00.000Z',
      )
      expect(row === undefined ? undefined : epochToDate(row.withHours).toISOString()).toBe(
        '2026-11-24T20:00:00.000Z',
      )
    })

    it('purges past the exact 720-hour boundary and leaves the row alone one hour short, even under a foreign session timezone', async () => {
      const due = await createOwnedArtifact('Exactly past the 720-hour window')
      const notDue = await createOwnedArtifact('One hour inside the 720-hour window')
      await softDeleteArtifact({ artifactId: due.id, viewerRef: userViewerRef(aliceId) })
      await softDeleteArtifact({ artifactId: notDue.id, viewerRef: userViewerRef(aliceId) })

      await db.transaction(async (transaction) => {
        await transaction.execute(sql`set local timezone = 'America/New_York'`)
        await transaction
          .update(artifacts)
          .set({ deletedAt: sql`now() - interval '720 hours' - interval '1 second'` })
          .where(eq(artifacts.id, due.id))
        await transaction
          .update(artifacts)
          .set({ deletedAt: sql`now() - interval '719 hours'` })
          .where(eq(artifacts.id, notDue.id))
      })

      await purgeTrashedArtifacts(store, RETENTION_DAYS)

      expect(await artifactRow(due.id)).toBeUndefined()
      expect(await artifactRow(notDue.id)).toBeDefined()
    })

    it('pins the pooled session TimeZone to UTC', async () => {
      const [row] = await db.execute<{ timezone: string }>(sql`select current_setting('timezone') as "timezone"`)
      expect(row?.timezone).toBe('UTC')
    })
  })
})
