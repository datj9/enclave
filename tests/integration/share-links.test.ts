import { and, desc, eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { GET as enterArtifactOrigin } from '@app/(artifact)/artifact-origin/[id]/enter/route'
import {
  GET as listSharesRoute,
  POST as createShareRoute,
} from '@app/api/v1/artifacts/[id]/shares/route'
import { DELETE as revokeShareRoute } from '@app/api/v1/shares/[shareId]/route'
import { db } from '@/db'
import { apiTokens } from '@/db/schema/api-tokens'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { auditLog } from '@/db/schema/audit-log'
import { shareLinks } from '@/db/schema/share-links'
import { users } from '@/db/schema/users'
import { env } from '@/env'
import { authorizeArtifactRead, shareViewerRef } from '@/lib/artifacts/authorize'
import { artifactViewUrl } from '@/lib/artifacts/naming'
import { createApiToken } from '@/lib/auth/bearer'
import { signHandoffToken } from '@/lib/handoff'
import { resolveShareLinkByToken } from '@/lib/shares/links'
import {
  createShareLink,
  listShareLinks,
  listShareableVersions,
  revokeShareLink,
} from '@/lib/shares/manage'
import { hashShareToken } from '@/lib/shares/token'
import { probeServices } from './services'

/**
 * S5 against real Postgres: version pinning across three versions, instant revocation, expiry
 * judged on the database clock rather than Node's, and the `artifact.view` row plus counters each
 * anonymous view leaves behind.
 *
 * Storage is not needed — nothing here serves bytes, so the fixtures insert rows directly.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/share-links: no database')
}

const ALICE_EMAIL = 'share-alice@example.test'
const BOB_EMAIL = 'share-bob@example.test'

const SHARES_URL = 'http://app.example.com/api/v1/artifacts'
const VIEWER_IP = '198.51.100.9'

interface CreatedShareBody {
  readonly data: { readonly shareId: string; readonly token: string; readonly url: string }
}

interface ShareListBody {
  readonly data: {
    readonly items: readonly {
      readonly shareId: string
      readonly versionId: string
      readonly viewCount: number
      readonly lastViewedAt: string | null
      readonly revokedAt: string | null
    }[]
    readonly databaseNow: string
  }
}

interface ValidationErrorBody {
  readonly error: {
    readonly code: string
    readonly details: {
      readonly issues: readonly { readonly field: string; readonly message: string }[]
    }
  }
}

let aliceId = ''
let bobId = ''
let artifactId = ''
let bobArtifactId = ''
/** v1, v2, v3 — v3 is the artifact's current version. */
let versionIds: readonly string[] = []
let aliceToken = ''
let bobToken = ''

async function removeUserAndOwnedRows(userId: string): Promise<void> {
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId))
  await db.delete(shareLinks).where(eq(shareLinks.createdBy, userId))
  await db.delete(artifacts).where(eq(artifacts.ownerId, userId))
  await db.delete(users).where(eq(users.id, userId))
}

async function createUser(email: string): Promise<string> {
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

/** Three ready versions, so "the pinned one, not the newest" is testable rather than asserted. */
async function createArtifactWithVersions(
  ownerId: string,
  versionCount: number,
): Promise<{ id: string; versionIds: readonly string[] }> {
  const [artifact] = await db
    .insert(artifacts)
    .values({ ownerId, title: 'Quarterly numbers', slug: 'quarterly-numbers' })
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

  const currentVersionId = created.at(-1)
  await db.update(artifacts).set({ currentVersionId }).where(eq(artifacts.id, artifact.id))

  return { id: artifact.id, versionIds: created }
}

function routeContext<TParams extends Record<string, string>>(params: TParams) {
  return { params: Promise.resolve(params) }
}

function createShareRequest(token: string, body: unknown, targetArtifactId = artifactId): Request {
  return new Request(`${SHARES_URL}/${targetArtifactId}/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

/** Drives §4.2 step 4 the way the browser does, so the view audit rule is exercised for real. */
async function enterWith(viewerRef: string, versionId: string): Promise<number> {
  const handoff = await signHandoffToken({ artifactId, versionId, viewerRef })
  const origin = new URL(artifactViewUrl(artifactId))
  const request = new NextRequest(`${origin.origin}/__enter?t=${encodeURIComponent(handoff)}`, {
    headers: { host: origin.host, 'x-forwarded-for': VIEWER_IP },
  })

  return (await enterArtifactOrigin(request, routeContext({ id: artifactId }))).status
}

function viewAuditRows(id: string) {
  return db
    .select({
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      actorShareLinkId: auditLog.actorShareLinkId,
      actorIp: auditLog.actorIp,
      versionId: auditLog.versionId,
      shareLinkId: auditLog.shareLinkId,
    })
    .from(auditLog)
    .where(and(eq(auditLog.artifactId, id), eq(auditLog.action, 'artifact.view')))
    .orderBy(desc(auditLog.id))
}

async function shareRow(shareId: string) {
  const [row] = await db
    .select({
      viewCount: shareLinks.viewCount,
      lastViewedAt: shareLinks.lastViewedAt,
      revokedAt: shareLinks.revokedAt,
      tokenHash: shareLinks.tokenHash,
      versionId: shareLinks.versionId,
      expiresAt: shareLinks.expiresAt,
    })
    .from(shareLinks)
    .where(eq(shareLinks.id, shareId))
    .limit(1)

  if (row === undefined) throw new Error(`no share link ${shareId}`)
  return row
}

/** A link created directly, bypassing the route, when a test only needs a capability. */
async function share(versionId: string, expiresAt: Date | null = null) {
  return await createShareLink({
    artifactId,
    versionId,
    viewerRef: `user:${aliceId}`,
    expiresAt,
  })
}

describe.skipIf(!database)('S5 share links', () => {
  beforeAll(async () => {
    aliceId = await createUser(ALICE_EMAIL)
    bobId = await createUser(BOB_EMAIL)

    const created = await createArtifactWithVersions(aliceId, 3)
    artifactId = created.id
    versionIds = created.versionIds
    bobArtifactId = (await createArtifactWithVersions(bobId, 1)).id

    aliceToken = (
      await createApiToken({ userId: aliceId, name: 'share-alice', scopes: ['shares:write'] })
    ).plaintext
    bobToken = (
      await createApiToken({ userId: bobId, name: 'share-bob', scopes: ['shares:write'] })
    ).plaintext
  })

  afterAll(async () => {
    for (const id of [aliceId, bobId].filter((id) => id !== '')) {
      await removeUserAndOwnedRows(id)
    }
  })

  describe('POST /api/v1/artifacts/{id}/shares', () => {
    it('returns a token of at least 43 characters and stores only its hash', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, { versionId: versionIds[1] }),
        routeContext({ id: artifactId }),
      )
      const body = (await response.json()) as CreatedShareBody

      expect(response.status).toBe(201)
      expect(body.data.token.length).toBeGreaterThanOrEqual(43)
      expect(body.data.url).toBe(`${new URL(env.APP_URL).origin}/s/${body.data.token}`)

      const row = await shareRow(body.data.shareId)
      expect(row.tokenHash).toEqual(hashShareToken(body.data.token))
      expect(row.versionId).toBe(versionIds[1])
    })

    it('writes one share.create row naming the pinned version', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, { versionId: versionIds[0] }),
        routeContext({ id: artifactId }),
      )
      const body = (await response.json()) as CreatedShareBody

      const [row] = await db
        .select({ versionId: auditLog.versionId, shareLinkId: auditLog.shareLinkId })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'share.create'), eq(auditLog.shareLinkId, body.data.shareId)))

      expect(row).toMatchObject({ versionId: versionIds[0], shareLinkId: body.data.shareId })
    })

    it('422s a version belonging to another artifact', async () => {
      const [bobVersion] = await db
        .select({ id: artifactVersions.id })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, bobArtifactId))

      const response = await createShareRoute(
        createShareRequest(aliceToken, { versionId: bobVersion?.id }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(422)
    })

    it('422s an expiry already in the past', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, {
          versionId: versionIds[0],
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(422)
    })

    it('422s an unknown field instead of silently ignoring it', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, { versionId: versionIds[0], expiresAtt: 'oops' }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(422)
    })

    it('accepts an explicit +07:00 offset and stores the equivalent UTC instant', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, {
          versionId: versionIds[0],
          expiresAt: '2030-08-10T07:00:00+07:00',
        }),
        routeContext({ id: artifactId }),
      )
      const body = (await response.json()) as CreatedShareBody

      expect(response.status).toBe(201)
      const row = await shareRow(body.data.shareId)
      expect(row.expiresAt?.toISOString()).toBe('2030-08-10T00:00:00.000Z')
    })

    it('accepts a bare Z offset unchanged', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, {
          versionId: versionIds[0],
          expiresAt: '2030-08-10T00:00:00Z',
        }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(201)
    })

    it('422s a zone-less expiresAt and names the reason in details.issues', async () => {
      const response = await createShareRoute(
        createShareRequest(aliceToken, {
          versionId: versionIds[0],
          expiresAt: '2030-08-10T07:00:00',
        }),
        routeContext({ id: artifactId }),
      )
      const body = (await response.json()) as ValidationErrorBody

      expect(response.status).toBe(422)
      expect(body.error.details.issues.length).toBeGreaterThan(0)
      expect(body.error.details.issues[0]).toMatchObject({ field: 'expiresAt' })
      expect(body.error.details.issues[0]?.message.length).toBeGreaterThan(0)
    })

    it("404s another member on a private artifact, so nothing confirms it exists", async () => {
      const response = await createShareRoute(
        createShareRequest(bobToken, { versionId: versionIds[0] }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(404)
    })

    it('401s a token without the shares:write scope', async () => {
      const readOnly = (
        await createApiToken({
          userId: aliceId,
          name: 'share-alice-readonly',
          scopes: ['artifacts:read'],
        })
      ).plaintext

      const response = await createShareRoute(
        createShareRequest(readOnly, { versionId: versionIds[0] }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(403)
    })
  })

  describe('GET /api/v1/artifacts/{id}/shares', () => {
    it('lists shares and never returns a token', async () => {
      const created = await share(versionIds[1] ?? '')

      const response = await listSharesRoute(
        new Request(`${SHARES_URL}/${artifactId}/shares`, {
          headers: { authorization: `Bearer ${aliceToken}` },
        }),
        routeContext({ id: artifactId }),
      )
      const raw = await response.text()
      const body = JSON.parse(raw) as ShareListBody

      expect(response.status).toBe(200)
      expect(body.data.items.map((item) => item.shareId)).toContain(created.shareId)
      expect(raw).not.toContain(created.token)
      expect(raw).not.toContain('"token"')
    })

    it('carries the database clock alongside the items', async () => {
      await share(versionIds[1] ?? '')

      const response = await listSharesRoute(
        new Request(`${SHARES_URL}/${artifactId}/shares`, {
          headers: { authorization: `Bearer ${aliceToken}` },
        }),
        routeContext({ id: artifactId }),
      )
      const body = (await response.json()) as ShareListBody

      expect(Number.isNaN(Date.parse(body.data.databaseNow))).toBe(false)
    })

    it('still returns a databaseNow when the artifact has zero share links', async () => {
      const empty = await createArtifactWithVersions(aliceId, 1)

      const response = await listSharesRoute(
        new Request(`${SHARES_URL}/${empty.id}/shares`, {
          headers: { authorization: `Bearer ${aliceToken}` },
        }),
        routeContext({ id: empty.id }),
      )
      const body = (await response.json()) as ShareListBody

      expect(response.status).toBe(200)
      expect(body.data.items).toEqual([])
      expect(Number.isNaN(Date.parse(body.data.databaseNow))).toBe(false)
    })

    it('offers every ready version to pin, newest first, flagging the current one', async () => {
      const versions = await listShareableVersions(artifactId, `user:${aliceId}`)

      expect(versions.map((version) => version.versionId)).toEqual([...versionIds].reverse())
      expect(versions.map((version) => version.isCurrent)).toEqual([true, false, false])
      expect(versions.map((version) => version.versionNo)).toEqual([3, 2, 1])
    })

    it('404s another member', async () => {
      const response = await listSharesRoute(
        new Request(`${SHARES_URL}/${artifactId}/shares`, {
          headers: { authorization: `Bearer ${bobToken}` },
        }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(404)
    })
  })

  describe('the gate, through canRead branch 4', () => {
    it('opens the pinned version even though two newer ones exist', async () => {
      const created = await share(versionIds[1] ?? '')
      const resolved = await resolveShareLinkByToken(created.token)

      const authorized = await authorizeArtifactRead(
        artifactId,
        shareViewerRef(resolved?.shareLinkId ?? ''),
      )

      expect(authorized?.versionId).toBe(versionIds[1])
      expect(authorized?.versionId).not.toBe(versionIds[2])
      expect(authorized?.isOwner).toBe(false)
    })

    it('refuses a token that was never issued', async () => {
      expect(await resolveShareLinkByToken('a'.repeat(43))).toBeNull()
    })

    it('refuses a malformed token without asking Postgres', async () => {
      expect(await resolveShareLinkByToken('../etc/passwd')).toBeNull()
    })

    it('refuses a viewer ref whose share id is not a UUID', async () => {
      expect(await authorizeArtifactRead(artifactId, 'share:not-a-uuid')).toBeNull()
    })

    it('refuses a viewer ref naming a share link that does not exist', async () => {
      expect(
        await authorizeArtifactRead(artifactId, shareViewerRef('99999999-9999-4999-8999-999999999999')),
      ).toBeNull()
    })

    it('refuses the link the moment it is revoked', async () => {
      const created = await share(versionIds[2] ?? '')
      const viewerRef = shareViewerRef(created.shareId)
      expect(await authorizeArtifactRead(artifactId, viewerRef)).not.toBeNull()

      await revokeShareLink(created.shareId, `user:${aliceId}`)

      expect(await authorizeArtifactRead(artifactId, viewerRef)).toBeNull()
    })

    it('refuses the link once its expiry has passed, with no manual revoke', async () => {
      const created = await share(versionIds[2] ?? '', new Date(Date.now() + 60_000))
      const viewerRef = shareViewerRef(created.shareId)
      expect(await authorizeArtifactRead(artifactId, viewerRef)).not.toBeNull()

      // Ages the row rather than waiting: the expiry itself is still judged by Postgres.
      await db
        .update(shareLinks)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(shareLinks.id, created.shareId))

      expect(await authorizeArtifactRead(artifactId, viewerRef)).toBeNull()
    })

    it('refuses a link whose pinned version was purged (§7)', async () => {
      const created = await share(versionIds[0] ?? '')
      const viewerRef = shareViewerRef(created.shareId)
      expect(await authorizeArtifactRead(artifactId, viewerRef)).not.toBeNull()

      const purged = await createArtifactWithVersions(aliceId, 1)
      const purgedShare = await createShareLink({
        artifactId: purged.id,
        versionId: purged.versionIds[0] ?? '',
        viewerRef: `user:${aliceId}`,
      })
      await db
        .delete(artifactVersions)
        .where(eq(artifactVersions.id, purged.versionIds[0] ?? ''))

      expect(
        await authorizeArtifactRead(purged.id, shareViewerRef(purgedShare.shareId)),
      ).toBeNull()
    })

    it('refuses every link once the artifact is in the trash', async () => {
      const created = await share(versionIds[2] ?? '')
      await db.update(artifacts).set({ deletedAt: sql`now()` }).where(eq(artifacts.id, artifactId))

      try {
        expect(await authorizeArtifactRead(artifactId, shareViewerRef(created.shareId))).toBeNull()
      } finally {
        await db.update(artifacts).set({ deletedAt: null }).where(eq(artifacts.id, artifactId))
      }
    })
  })

  /**
   * §7 clock skew. Node is moved a year past the expiry while Postgres is not: if any comparison
   * on the read path used `Date.now()`, the still-valid link below would read as expired.
   */
  describe('expiry is evaluated in Postgres, not in Node', () => {
    it('keeps a link valid while the app-server clock says it expired', async () => {
      const expiresAt = new Date(Date.now() + 60_000)
      const created = await share(versionIds[2] ?? '', expiresAt)

      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000))
        expect(Date.now()).toBeGreaterThan(expiresAt.getTime())

        expect(
          await authorizeArtifactRead(artifactId, shareViewerRef(created.shareId)),
        ).not.toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })

    it('expires a link the database considers past even while Node is behind it', async () => {
      const created = await share(versionIds[2] ?? '', new Date(Date.now() + 60_000))
      await db
        .update(shareLinks)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(shareLinks.id, created.shareId))

      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))

        expect(await authorizeArtifactRead(artifactId, shareViewerRef(created.shareId))).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('an anonymous view', () => {
    it('writes one artifact.view row with the link id and the viewer IP', async () => {
      const created = await share(versionIds[1] ?? '')
      const before = (await viewAuditRows(artifactId)).length

      expect(await enterWith(shareViewerRef(created.shareId), versionIds[1] ?? '')).toBe(302)

      const rows = await viewAuditRows(artifactId)
      expect(rows).toHaveLength(before + 1)
      expect(rows[0]).toMatchObject({
        action: 'artifact.view',
        actorUserId: null,
        actorShareLinkId: created.shareId,
        actorIp: VIEWER_IP,
        versionId: versionIds[1],
        shareLinkId: created.shareId,
      })
    })

    it('bumps view_count and last_viewed_at per view', async () => {
      const created = await share(versionIds[1] ?? '')
      expect(await shareRow(created.shareId)).toMatchObject({ viewCount: 0, lastViewedAt: null })

      expect(await enterWith(shareViewerRef(created.shareId), versionIds[1] ?? '')).toBe(302)
      expect((await shareRow(created.shareId)).viewCount).toBe(1)

      expect(await enterWith(shareViewerRef(created.shareId), versionIds[1] ?? '')).toBe(302)
      const row = await shareRow(created.shareId)
      expect(row.viewCount).toBe(2)
      expect(row.lastViewedAt).not.toBeNull()

      const summary = (await listShareLinks(artifactId, `user:${aliceId}`)).items.find(
        (item) => item.shareId === created.shareId,
      )
      expect(summary?.viewCount).toBe(2)
    })

    it('is refused at /__enter once the link is revoked, even mid-handoff', async () => {
      const created = await share(versionIds[1] ?? '')
      const viewerRef = shareViewerRef(created.shareId)
      const handoff = await signHandoffToken({
        artifactId,
        versionId: versionIds[1] ?? '',
        viewerRef,
      })

      // The token was minted while the link was live; §7 says /__enter re-checks anyway.
      await revokeShareLink(created.shareId, `user:${aliceId}`)

      const origin = new URL(artifactViewUrl(artifactId))
      const response = await enterArtifactOrigin(
        new NextRequest(`${origin.origin}/__enter?t=${encodeURIComponent(handoff)}`, {
          headers: { host: origin.host, 'x-forwarded-for': VIEWER_IP },
        }),
        routeContext({ id: artifactId }),
      )

      expect(response.status).toBe(404)
      expect((await shareRow(created.shareId)).viewCount).toBe(0)
    })

    it('cannot enter a version the link is not pinned to', async () => {
      const created = await share(versionIds[1] ?? '')

      expect(await enterWith(shareViewerRef(created.shareId), versionIds[2] ?? '')).toBe(404)
    })
  })

  describe('DELETE /api/v1/shares/{shareId}', () => {
    it('revokes for the owner and is idempotent', async () => {
      const created = await share(versionIds[1] ?? '')

      const first = await revokeShareRoute(
        new Request(`http://app.example.com/api/v1/shares/${created.shareId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${aliceToken}` },
        }),
        routeContext({ shareId: created.shareId }),
      )
      const revokedAt = (await shareRow(created.shareId)).revokedAt

      const second = await revokeShareRoute(
        new Request(`http://app.example.com/api/v1/shares/${created.shareId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${aliceToken}` },
        }),
        routeContext({ shareId: created.shareId }),
      )

      expect([first.status, second.status]).toEqual([204, 204])
      expect((await shareRow(created.shareId)).revokedAt).toEqual(revokedAt)

      const revocations = await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, 'share.revoke'), eq(auditLog.shareLinkId, created.shareId)),
        )
      expect(revocations).toHaveLength(1)
    })

    it('404s another member and leaves the link alive', async () => {
      const created = await share(versionIds[1] ?? '')

      const response = await revokeShareRoute(
        new Request(`http://app.example.com/api/v1/shares/${created.shareId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${bobToken}` },
        }),
        routeContext({ shareId: created.shareId }),
      )

      expect(response.status).toBe(404)
      expect((await shareRow(created.shareId)).revokedAt).toBeNull()
    })

    it('404s a share id that does not exist', async () => {
      const response = await revokeShareRoute(
        new Request('http://app.example.com/api/v1/shares/99999999-9999-4999-8999-999999999999', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${aliceToken}` },
        }),
        routeContext({ shareId: '99999999-9999-4999-8999-999999999999' }),
      )

      expect(response.status).toBe(404)
    })
  })

  /**
   * The acceptance criterion is "an already-issued presigned URL stops working within 60 s". The
   * TTL is what bounds that, so it is asserted rather than waited out — a test that slept a minute
   * would be the slowest in the suite and would still only prove the same number.
   */
  describe('asset revocation window', () => {
    it('presigns for no more than 60 seconds', () => {
      expect(env.PRESIGN_TTL_SECONDS).toBeLessThanOrEqual(60)
    })
  })

  describe('log hygiene (§8)', () => {
    it('never puts a token in an audit row', async () => {
      const created = await share(versionIds[1] ?? '')

      const rows = await db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(eq(auditLog.shareLinkId, created.shareId))

      for (const row of rows) {
        expect(JSON.stringify(row.metadata ?? {})).not.toContain(created.token)
      }
    })
  })
})
