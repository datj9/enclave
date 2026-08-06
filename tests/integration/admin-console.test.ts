import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { invites } from '@/db/schema/invites'
import { users } from '@/db/schema/users'
import { DEFAULT_AUDIT_LIMIT } from '@/lib/admin/audit-query'
import { readAuditPage } from '@/lib/admin/audit-read'
import {
  ARTIFACTS_BLOCK_DELETION,
  CANNOT_CHANGE_SELF,
  deleteUser,
  listUsers,
  setUserAccess,
} from '@/lib/admin/users'
import { authorizeArtifactRead, resolveViewer, userViewerRef } from '@/lib/artifacts/authorize'
import { createInvite } from '@/lib/invites/manage'
import { probeServices } from './services'

/**
 * The admin surface against real Postgres (US-11, A.9.4.1). The load-bearing claim is the one
 * decision #26 makes: an admin operates the instance and still cannot read a private artifact.
 * Nothing here needs object storage — no admin path serves bytes, which is the point.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/admin-console: no database')
}

const ADMIN_EMAIL = 'console-carol-admin@example.test'
const OWNER_EMAIL = 'console-alice@example.test'
const READER_EMAIL = 'console-bob@example.test'
const SPARE_EMAIL = 'console-dave@example.test'

const TEST_EMAILS = [ADMIN_EMAIL, OWNER_EMAIL, READER_EMAIL, SPARE_EMAIL]

let adminId = ''
let ownerId = ''
let readerId = ''
let spareId = ''
let privateArtifactId = ''
let orgArtifactId = ''

const SECRET_TITLE = 'Board compensation review'

async function removeTestRows(): Promise<void> {
  const testUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.email, TEST_EMAILS))
  const ids = testUsers.map((user) => user.id)
  if (ids.length === 0) return

  await db.update(invites).set({ usedBy: null }).where(inArray(invites.usedBy, ids))
  await db.delete(invites).where(inArray(invites.createdBy, ids))
  await db.delete(artifacts).where(inArray(artifacts.ownerId, ids))
  await db.delete(users).where(inArray(users.id, ids))
}

async function createUser(email: string, role: 'admin' | 'member'): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: null, role, isActive: true })
    .returning({ id: users.id })

  if (user === undefined) throw new Error(`could not create ${email}`)
  return user.id
}

async function createArtifactRow(
  owner: string,
  title: string,
  visibility: 'private' | 'org' | 'public',
): Promise<string> {
  const [artifact] = await db
    .insert(artifacts)
    .values({ ownerId: owner, title, slug: 'fixture', visibility })
    .returning({ id: artifacts.id })

  if (artifact === undefined) throw new Error('could not create the artifact')

  const [version] = await db
    .insert(artifactVersions)
    .values({
      artifactId: artifact.id,
      versionNo: 1,
      status: 'ready',
      entryPath: 'index.html',
      manifest: [{ path: 'index.html', bytes: 12, content_type: 'text/html', sha256: 'x' }],
      totalBytes: 12,
      fileCount: 1,
      createdBy: owner,
    })
    .returning({ id: artifactVersions.id })

  if (version === undefined) throw new Error('could not create the version')

  await db.update(artifacts).set({ currentVersionId: version.id }).where(eq(artifacts.id, artifact.id))
  return artifact.id
}

function emptyFilter() {
  return {
    action: undefined,
    actorUserId: undefined,
    artifactId: undefined,
    from: undefined,
    to: undefined,
    limit: DEFAULT_AUDIT_LIMIT,
    cursor: undefined,
  } as const
}

describe.skipIf(!database)('the admin console', () => {
  beforeAll(async () => {
    await removeTestRows()
    adminId = await createUser(ADMIN_EMAIL, 'admin')
    ownerId = await createUser(OWNER_EMAIL, 'member')
    readerId = await createUser(READER_EMAIL, 'member')
    spareId = await createUser(SPARE_EMAIL, 'member')

    privateArtifactId = await createArtifactRow(ownerId, SECRET_TITLE, 'private')
    orgArtifactId = await createArtifactRow(ownerId, 'Shared numbers', 'org')
  })

  afterAll(removeTestRows)

  describe('the admin exclusion (§5.1 branch 6, decision #26)', () => {
    it('refuses an admin another user’s private artifact', async () => {
      const authorized = await authorizeArtifactRead(privateArtifactId, userViewerRef(adminId))

      expect(authorized).toBeNull()
    })

    it('is not a side effect of the admin being unresolvable — the viewer resolves fine', async () => {
      const viewer = await resolveViewer(userViewerRef(adminId))

      expect(viewer).toEqual({ kind: 'user', id: adminId, role: 'admin', isActive: true })
    })

    it('still lets the admin read an org-visible artifact, like any other member', async () => {
      const authorized = await authorizeArtifactRead(orgArtifactId, userViewerRef(adminId))

      expect(authorized?.artifactId).toBe(orgArtifactId)
    })

    it('never leaks a private artifact’s title through the user roster', async () => {
      const roster = await listUsers()

      expect(JSON.stringify(roster)).not.toContain(SECRET_TITLE)
    })

    it('never leaks a private artifact’s title through the audit viewer', async () => {
      const page = await readAuditPage({ ...emptyFilter(), artifactId: privateArtifactId })

      expect(JSON.stringify(page)).not.toContain(SECRET_TITLE)
    })
  })

  describe('the user roster', () => {
    it('reports artifact counts without any artifact content', async () => {
      const owner = (await listUsers()).find((person) => person.id === ownerId)

      expect(owner?.liveArtifactCount).toBe(2)
      expect(owner?.sharedArtifactCount).toBe(1)
    })

    it('counts a public artifact as shared, like an org one', async () => {
      const publicArtifactId = await createArtifactRow(ownerId, 'Open to all', 'public')

      try {
        const owner = (await listUsers()).find((person) => person.id === ownerId)

        expect(owner?.liveArtifactCount).toBe(3)
        expect(owner?.sharedArtifactCount).toBe(2)
      } finally {
        await db.delete(artifacts).where(eq(artifacts.id, publicArtifactId))
      }
    })

    it('reports zero for a user who owns nothing', async () => {
      const spare = (await listUsers()).find((person) => person.id === spareId)

      expect([spare?.liveArtifactCount, spare?.sharedArtifactCount]).toEqual([0, 0])
    })
  })

  describe('deactivation', () => {
    afterAll(async () => {
      await setUserAccess({ actorId: adminId, userId: readerId, isActive: true })
    })

    it('records deactivated_at and writes a user.deactivate audit row', async () => {
      const updated = await setUserAccess({ actorId: adminId, userId: readerId, isActive: false })

      expect(updated.isActive).toBe(false)
      expect(updated.deactivatedAt).not.toBeNull()

      const page = await readAuditPage({ ...emptyFilter(), action: 'user.deactivate', actorUserId: adminId })
      expect(page.items.at(0)?.metadata).toMatchObject({ userId: readerId })
    })

    it('stops resolving the deactivated user as a viewer, so their next request 401s', async () => {
      expect(await resolveViewer(userViewerRef(readerId))).toBeNull()
    })

    it('leaves the org-visible artifacts they could read visible to everyone else', async () => {
      const stillReadable = await authorizeArtifactRead(orgArtifactId, userViewerRef(spareId))

      expect(stillReadable?.artifactId).toBe(orgArtifactId)
    })

    it('leaves the deactivated user’s own artifacts alone', async () => {
      const owned = await db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.ownerId, ownerId))

      expect(owned).toHaveLength(2)
    })

    it('refuses an admin deactivating themselves', async () => {
      await expect(
        setUserAccess({ actorId: adminId, userId: adminId, isActive: false }),
      ).rejects.toMatchObject({ status: 422, message: CANNOT_CHANGE_SELF })
    })
  })

  describe('deletion', () => {
    it('is blocked with 409 and names the blocking artifacts — never a cascade', async () => {
      const rejection = deleteUser({ actorId: adminId, userId: ownerId })

      await expect(rejection).rejects.toMatchObject({
        status: 409,
        code: 'VALIDATION_FAILED',
        message: ARTIFACTS_BLOCK_DELETION,
      })

      await expect(rejection).rejects.toSatisfy((error: { details?: Record<string, unknown> }) => {
        const blocking = error.details?.['blockingArtifactIds']
        return (
          Array.isArray(blocking) &&
          blocking.includes(orgArtifactId) &&
          blocking.includes(privateArtifactId)
        )
      })
    })

    it('leaves the user and every artifact in place after the refusal', async () => {
      const [survivor] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId))
      const owned = await db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.ownerId, ownerId))

      expect(survivor?.id).toBe(ownerId)
      expect(owned).toHaveLength(2)
    })

    it('refuses an admin deleting themselves', async () => {
      await expect(deleteUser({ actorId: adminId, userId: adminId })).rejects.toMatchObject({
        status: 422,
      })
    })

    it('removes a user who owns nothing, and keeps the invite they redeemed', async () => {
      const invite = await createInvite({ createdBy: adminId, email: SPARE_EMAIL, expiresInHours: 1 })
      await db.update(invites).set({ usedBy: spareId, usedAt: new Date() }).where(eq(invites.id, invite.inviteId))

      await deleteUser({ actorId: adminId, userId: spareId })

      const [gone] = await db.select({ id: users.id }).from(users).where(eq(users.id, spareId))
      const [row] = await db
        .select({ usedAt: invites.usedAt, usedBy: invites.usedBy })
        .from(invites)
        .where(eq(invites.id, invite.inviteId))

      expect(gone).toBeUndefined()
      expect(row?.usedAt).not.toBeNull()
      expect(row?.usedBy).toBeNull()
    })
  })

  describe('the audit viewer', () => {
    it('filters by actor', async () => {
      const page = await readAuditPage({ ...emptyFilter(), actorUserId: adminId })

      expect(page.items.length).toBeGreaterThan(0)
      expect(page.items.every((entry) => entry.actorUserId === adminId)).toBe(true)
    })

    it('filters by action', async () => {
      const page = await readAuditPage({ ...emptyFilter(), action: 'user.invite' })

      expect(page.items.every((entry) => entry.action === 'user.invite')).toBe(true)
    })

    it('filters by date range', async () => {
      const future = new Date(Date.now() + 86_400_000)
      const page = await readAuditPage({ ...emptyFilter(), from: future })

      expect(page.items).toHaveLength(0)
    })

    it('resolves the actor’s address so the operator reads names, not uuids', async () => {
      const page = await readAuditPage({ ...emptyFilter(), actorUserId: adminId })

      expect(page.items.at(0)?.actorEmail).toBe(ADMIN_EMAIL)
    })

    it('pages with a keyset cursor that does not repeat a row', async () => {
      const first = await readAuditPage({ ...emptyFilter(), limit: 1 })
      if (first.nextCursor === null) return

      const cursor = decodeCursorForTest(first.nextCursor)
      const second = await readAuditPage({ ...emptyFilter(), limit: 1, cursor })

      expect(second.items.at(0)?.id).not.toBe(first.items.at(0)?.id)
    })
  })
})

/** Local rather than imported so a change to the encoding fails this test loudly. */
function decodeCursorForTest(encoded: string) {
  const [at, id] = Buffer.from(encoded, 'base64url').toString('utf8').split('|')
  return { at: at ?? '', id: Number(id) }
}
