import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { GET as listSharesRoute } from '@app/api/v1/artifacts/[id]/shares/route'
import { db } from '@/db'
import { apiTokens } from '@/db/schema/api-tokens'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { shareLinks } from '@/db/schema/share-links'
import { users } from '@/db/schema/users'
import { createApiToken } from '@/lib/auth/bearer'
import { countLiveShareLinks } from '@/lib/shares/live'
import { listShareLinks } from '@/lib/shares/manage'
import { probeServices } from './services'

/**
 * Issue #25 against real Postgres: the number the `Only me` warning names. "Live" is `canRead`
 * branch 4's revoke-and-expiry half, so the four states a link can be in are seeded and counted
 * rather than reasoned about — and the expiry boundary is proved to be Postgres' `now()` by moving
 * Node's clock a year off it in both directions.
 *
 * Storage is not needed: nothing here serves bytes.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/live-share-links: no database')
}

const OWNER_EMAIL = 'live-count-owner@example.test'
const SHARES_URL = 'http://app.example.com/api/v1/artifacts'

interface ShareListBody {
  readonly data: { readonly liveCount: number; readonly items: readonly unknown[] }
}

let ownerId = ''
let ownerToken = ''
let artifactId = ''
let versionIds: readonly string[] = []

async function removeUserAndOwnedRows(userId: string): Promise<void> {
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId))
  await db.delete(shareLinks).where(eq(shareLinks.createdBy, userId))
  await db.delete(artifacts).where(eq(artifacts.ownerId, userId))
  await db.delete(users).where(eq(users.id, userId))
}

async function createOwner(email: string): Promise<string> {
  const stale = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  for (const user of stale) {
    await removeUserAndOwnedRows(user.id)
  }

  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (user === undefined) throw new Error(`could not create ${email}`)
  return user.id
}

/** Two ready versions, so "counted per artifact, not per version" is testable. */
async function createArtifactWithVersions(
  versionCount: number,
): Promise<{ id: string; versionIds: readonly string[] }> {
  const [artifact] = await db
    .insert(artifacts)
    .values({ ownerId, title: 'Live link count', slug: 'live-link-count' })
    .returning({ id: artifacts.id })

  if (artifact === undefined) throw new Error('could not create the artifact')

  const created: string[] = []
  for (let versionNo = 1; versionNo <= versionCount; versionNo += 1) {
    const [version] = await db
      .insert(artifactVersions)
      .values({
        artifactId: artifact.id,
        versionNo,
        status: 'ready',
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', bytes: 12, content_type: 'text/html', sha256: `v${versionNo}` },
        ],
        totalBytes: 12,
        fileCount: 1,
        createdBy: ownerId,
      })
      .returning({ id: artifactVersions.id })

    if (version === undefined) throw new Error('could not create the version')
    created.push(version.id)
  }

  await db
    .update(artifacts)
    .set({ currentVersionId: created.at(-1) })
    .where(eq(artifacts.id, artifact.id))

  return { id: artifact.id, versionIds: created }
}

/**
 * A row written straight to the table. `createShareLink` refuses an expiry already in the past, and
 * two of the four §5 rows need exactly that.
 */
async function seedLink(
  targetArtifactId: string,
  versionId: string,
  fields: { readonly revokedAt?: 'now' | null; readonly expiresIn?: string | null } = {},
): Promise<string> {
  const [row] = await db
    .insert(shareLinks)
    .values({
      artifactId: targetArtifactId,
      versionId,
      tokenHash: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
      createdBy: ownerId,
      revokedAt: fields.revokedAt === 'now' ? sql`now()` : null,
      expiresAt:
        fields.expiresIn === undefined || fields.expiresIn === null
          ? null
          : sql`now() + ${fields.expiresIn}::interval`,
    })
    .returning({ id: shareLinks.id })

  if (row === undefined) throw new Error('could not seed the share link')
  return row.id
}

describe.skipIf(!database)('countLiveShareLinks', () => {
  beforeAll(async () => {
    ownerId = await createOwner(OWNER_EMAIL)
    const created = await createArtifactWithVersions(2)
    artifactId = created.id
    versionIds = created.versionIds
    ownerToken = (
      await createApiToken({ userId: ownerId, name: 'live-count', scopes: ['shares:write'] })
    ).plaintext
  })

  afterAll(async () => {
    if (ownerId !== '') await removeUserAndOwnedRows(ownerId)
  })

  it('counts nothing for an artifact that has never been shared', async () => {
    const empty = await createArtifactWithVersions(1)

    expect(await countLiveShareLinks(empty.id)).toBe(0)
  })

  /** The four rows of the issue's worked example: live, live-with-expiry, revoked, expired. */
  it('counts only the links that still open the artifact', async () => {
    const scoped = await createArtifactWithVersions(1)
    const versionId = scoped.versionIds[0] ?? ''

    await seedLink(scoped.id, versionId)
    await seedLink(scoped.id, versionId, { expiresIn: '1 hour' })
    await seedLink(scoped.id, versionId, { revokedAt: 'now' })
    await seedLink(scoped.id, versionId, { expiresIn: '-1 hour' })

    expect(await countLiveShareLinks(scoped.id)).toBe(2)
  })

  it('counts a revoked link as dead even when its expiry is still in the future', async () => {
    const scoped = await createArtifactWithVersions(1)
    await seedLink(scoped.id, scoped.versionIds[0] ?? '', {
      revokedAt: 'now',
      expiresIn: '1 hour',
    })

    expect(await countLiveShareLinks(scoped.id)).toBe(0)
  })

  it('counts a link pinned to an older version — the number is per artifact', async () => {
    const scoped = await createArtifactWithVersions(2)
    await seedLink(scoped.id, scoped.versionIds[0] ?? '')

    expect(await countLiveShareLinks(scoped.id)).toBe(1)
  })

  it('counts links of this artifact only', async () => {
    const mine = await createArtifactWithVersions(1)
    const other = await createArtifactWithVersions(1)
    await seedLink(mine.id, mine.versionIds[0] ?? '')
    await seedLink(other.id, other.versionIds[0] ?? '')

    expect(await countLiveShareLinks(mine.id)).toBe(1)
  })

  /**
   * §7 clock skew. Node is moved a year past the expiry while Postgres is not: a count judged with
   * `Date.now()` would drop the link below, and one judged in Postgres keeps it.
   */
  describe('the expiry boundary is judged by Postgres, not by Node', () => {
    it('keeps counting a link the app-server clock believes expired', async () => {
      const scoped = await createArtifactWithVersions(1)
      await seedLink(scoped.id, scoped.versionIds[0] ?? '', { expiresIn: '1 minute' })

      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))

        expect(await countLiveShareLinks(scoped.id)).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops counting a link Postgres considers expired while Node is behind it', async () => {
      const scoped = await createArtifactWithVersions(1)
      await seedLink(scoped.id, scoped.versionIds[0] ?? '', { expiresIn: '-1 second' })

      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))

        expect(await countLiveShareLinks(scoped.id)).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('GET /api/v1/artifacts/{id}/shares', () => {
    it('carries the live count alongside the rows, ignoring the dead ones', async () => {
      await seedLink(artifactId, versionIds[0] ?? '')
      await seedLink(artifactId, versionIds[1] ?? '', { expiresIn: '1 hour' })
      await seedLink(artifactId, versionIds[0] ?? '', { revokedAt: 'now' })

      const response = await listSharesRoute(
        new Request(`${SHARES_URL}/${artifactId}/shares`, {
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
        { params: Promise.resolve({ id: artifactId }) },
      )
      const body = (await response.json()) as ShareListBody

      expect(response.status).toBe(200)
      expect(body.data.items).toHaveLength(3)
      expect(body.data.liveCount).toBe(2)
    })

    it('reports zero for an artifact whose only link was revoked', async () => {
      const scoped = await createArtifactWithVersions(1)
      await seedLink(scoped.id, scoped.versionIds[0] ?? '', { revokedAt: 'now' })

      const listed = await listShareLinks(scoped.id, `user:${ownerId}`)

      expect(listed.items).toHaveLength(1)
      expect(listed.liveCount).toBe(0)
    })
  })
})
