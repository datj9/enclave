import { and, desc, eq, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { GET as enterArtifactOrigin } from '@app/(artifact)/artifact-origin/[id]/enter/route'
import {
  DELETE as deleteArtifactRoute,
  GET as getArtifactRoute,
  PATCH as patchArtifactRoute,
} from '@app/api/v1/artifacts/[id]/route'
import { db } from '@/db'
import { AUDIT_LOG_APPEND_ONLY_DDL } from '@/db/audit-log-guard'
import { apiTokens } from '@/db/schema/api-tokens'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { auditLog } from '@/db/schema/audit-log'
import { users } from '@/db/schema/users'
import {
  ANONYMOUS_VIEWER_REF,
  apiTokenViewerRef,
  authorizeArtifactRead,
  userViewerRef,
} from '@/lib/artifacts/authorize'
import { artifactViewUrl } from '@/lib/artifacts/naming'
import {
  readArtifactView,
  softDeleteArtifact,
  updateArtifact,
} from '@/lib/artifacts/update'
import { createApiToken } from '@/lib/auth/bearer'
import { signHandoffToken } from '@/lib/handoff'
import { pruneAuditLog } from '@/jobs/prune-audit'
import { probeServices } from './services'

/**
 * S4 against real Postgres: the §5.1 gate as the rest of the product actually calls it, the
 * `audit_log` rows each transition leaves behind, and the append-only trigger that stops the
 * application deleting its own audit trail.
 *
 * Storage is not needed — nothing here serves bytes, so the fixtures insert rows directly.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/privacy-gate: no database')
}

const ALICE_EMAIL = 'privacy-alice@example.test'
const BOB_EMAIL = 'privacy-bob@example.test'
const CAROL_EMAIL = 'privacy-carol-admin@example.test'

const ARTIFACT_URL = 'http://app.example.com/api/v1/artifacts'

interface ViewBody {
  readonly data: { readonly id: string; readonly visibility: string }
}

let aliceId = ''
let bobId = ''
let carolId = ''
let artifactId = ''
let versionId = ''
let aliceToken = ''
let bobToken = ''

async function removeUserAndOwnedRows(userId: string): Promise<void> {
  await db.delete(apiTokens).where(eq(apiTokens.userId, userId))
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

async function createPrivateArtifact(ownerId: string): Promise<{ id: string; versionId: string }> {
  const [artifact] = await db
    .insert(artifacts)
    .values({ ownerId, title: 'Quarterly numbers', slug: 'quarterly-numbers' })
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
      createdBy: ownerId,
    })
    .returning({ id: artifactVersions.id })

  if (version === undefined) throw new Error('could not create the version')

  await db
    .update(artifacts)
    .set({ currentVersionId: version.id })
    .where(eq(artifacts.id, artifact.id))

  return { id: artifact.id, versionId: version.id }
}

function auditRowsFor(id: string) {
  return db
    .select({ action: auditLog.action, actorUserId: auditLog.actorUserId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(eq(auditLog.artifactId, id))
    .orderBy(desc(auditLog.id))
}

function patchRequest(token: string, body: unknown): Request {
  return new Request(`${ARTIFACT_URL}/${artifactId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

function routeContext(id: string) {
  return { params: Promise.resolve({ id }) }
}

async function setVisibility(visibility: 'private' | 'org' | 'public'): Promise<void> {
  await db.update(artifacts).set({ visibility }).where(eq(artifacts.id, artifactId))
}

/** Drives §4.2 step 4 the way the browser does, so the `artifact.view` rule is tested for real. */
async function enterArtifact(viewerRef: string): Promise<number> {
  const token = await signHandoffToken({ artifactId, versionId, viewerRef })
  const origin = new URL(artifactViewUrl(artifactId))
  const request = new NextRequest(`${origin.origin}/__enter?t=${encodeURIComponent(token)}`, {
    headers: { host: origin.host, 'x-forwarded-for': '203.0.113.7' },
  })

  return (await enterArtifactOrigin(request, routeContext(artifactId))).status
}

/** Drizzle wraps the driver error, so the trigger's message arrives on `cause`. */
async function rejectionText(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    return `${String(error)} ${cause instanceof Error ? cause.message : String(cause)}`
  }
  throw new Error('expected the statement to be refused')
}

describe.skipIf(!database)('S4 privacy gate and audit log', () => {
  beforeAll(async () => {
    aliceId = await createUser(ALICE_EMAIL, 'member')
    bobId = await createUser(BOB_EMAIL, 'member')
    carolId = await createUser(CAROL_EMAIL, 'admin')

    const created = await createPrivateArtifact(aliceId)
    artifactId = created.id
    versionId = created.versionId

    aliceToken = (
      await createApiToken({
        userId: aliceId,
        name: 'privacy-alice',
        scopes: ['artifacts:read', 'artifacts:write'],
      })
    ).plaintext
    bobToken = (
      await createApiToken({
        userId: bobId,
        name: 'privacy-bob',
        scopes: ['artifacts:read', 'artifacts:write'],
      })
    ).plaintext

    await db.execute(sql.raw(AUDIT_LOG_APPEND_ONLY_DDL))
  })

  afterAll(async () => {
    for (const id of [aliceId, bobId, carolId].filter((id) => id !== '')) {
      await removeUserAndOwnedRows(id)
    }
  })

  describe('the gate as every read path calls it', () => {
    it('lets the owner read their own private artifact', async () => {
      await setVisibility('private')
      const authorized = await authorizeArtifactRead(artifactId, userViewerRef(aliceId))

      expect(authorized?.versionId).toBe(versionId)
      expect(authorized?.isOwner).toBe(true)
      expect(authorized?.visibility).toBe('private')
    })

    it('refuses another member, with no way to tell it apart from a missing artifact', async () => {
      await setVisibility('private')

      expect(await authorizeArtifactRead(artifactId, userViewerRef(bobId))).toBeNull()
      expect(
        await authorizeArtifactRead('99999999-9999-4999-8999-999999999999', userViewerRef(bobId)),
      ).toBeNull()
    })

    it("refuses an admin on someone else's private artifact", async () => {
      await setVisibility('private')

      expect(await authorizeArtifactRead(artifactId, userViewerRef(carolId))).toBeNull()
    })

    it('lets any signed-in member read it once it is org', async () => {
      await setVisibility('org')
      const authorized = await authorizeArtifactRead(artifactId, userViewerRef(bobId))

      expect(authorized?.versionId).toBe(versionId)
      expect(authorized?.isOwner).toBe(false)
    })

    it('lets an admin read it once it is org, like any other member', async () => {
      await setVisibility('org')

      expect(await authorizeArtifactRead(artifactId, userViewerRef(carolId))).not.toBeNull()
    })

    it('revokes the owner the moment they are deactivated', async () => {
      await setVisibility('private')
      await db.update(users).set({ isActive: false }).where(eq(users.id, aliceId))

      try {
        expect(await authorizeArtifactRead(artifactId, userViewerRef(aliceId))).toBeNull()
        expect(await authorizeArtifactRead(artifactId, apiTokenViewerRef(aliceId))).toBeNull()
      } finally {
        await db.update(users).set({ isActive: true }).where(eq(users.id, aliceId))
      }
    })

    it('keeps an API token owner-scoped even on an org artifact (§5.1 branch 3)', async () => {
      await setVisibility('org')

      expect(await authorizeArtifactRead(artifactId, apiTokenViewerRef(aliceId))).not.toBeNull()
      expect(await authorizeArtifactRead(artifactId, apiTokenViewerRef(bobId))).toBeNull()
    })

    it('lets a viewer with no session at all read it once it is public', async () => {
      await setVisibility('public')
      const authorized = await authorizeArtifactRead(artifactId, ANONYMOUS_VIEWER_REF)

      expect(authorized?.versionId).toBe(versionId)
      expect(authorized?.visibility).toBe('public')
      // Nothing about an anonymous read is ownership, whatever the artifact's level.
      expect(authorized?.isOwner).toBe(false)
    })

    it('refuses that same viewer at every other level', async () => {
      for (const visibility of ['private', 'org'] as const) {
        await setVisibility(visibility)

        expect(await authorizeArtifactRead(artifactId, ANONYMOUS_VIEWER_REF)).toBeNull()
      }
    })

    it('refuses a ref that only looks anonymous', async () => {
      await setVisibility('public')

      expect(await authorizeArtifactRead(artifactId, 'anon:someone')).toBeNull()
      expect(await authorizeArtifactRead(artifactId, 'anon')).toBeNull()
    })

    it('opens a public artifact to another member and to an admin, and closes again', async () => {
      await setVisibility('public')

      expect(await authorizeArtifactRead(artifactId, userViewerRef(bobId))).not.toBeNull()
      expect(await authorizeArtifactRead(artifactId, userViewerRef(carolId))).not.toBeNull()

      await setVisibility('private')

      expect(await authorizeArtifactRead(artifactId, userViewerRef(bobId))).toBeNull()
      expect(await authorizeArtifactRead(artifactId, userViewerRef(carolId))).toBeNull()
    })

    it('refuses everyone once the artifact is in the trash', async () => {
      await setVisibility('org')
      await db.update(artifacts).set({ deletedAt: sql`now()` }).where(eq(artifacts.id, artifactId))

      try {
        expect(await authorizeArtifactRead(artifactId, userViewerRef(aliceId))).toBeNull()
        expect(await authorizeArtifactRead(artifactId, userViewerRef(bobId))).toBeNull()
      } finally {
        await db.update(artifacts).set({ deletedAt: null }).where(eq(artifacts.id, artifactId))
      }
    })
  })

  describe('PATCH /api/v1/artifacts/{id}', () => {
    it('404s a non-owner on a private artifact rather than 403, so nothing leaks', async () => {
      await setVisibility('private')
      const response = await patchArtifactRoute(
        patchRequest(bobToken, { visibility: 'org' }),
        routeContext(artifactId),
      )

      expect(response.status).toBe(404)
    })

    // A bearer token stays owner-scoped (§5.1 branch 3), so it cannot even read the org artifact
    // and gets the same 404 it would for a private one. The 403 belongs to the session path,
    // asserted below in "the session write path" and end to end in privacy-and-audit.spec.ts.
    it('404s a non-owner token on an org artifact, PATCH and DELETE alike', async () => {
      await setVisibility('org')
      const patch = await patchArtifactRoute(
        patchRequest(bobToken, { visibility: 'private' }),
        routeContext(artifactId),
      )
      const remove = await deleteArtifactRoute(
        new Request(`${ARTIFACT_URL}/${artifactId}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${bobToken}` },
        }),
        routeContext(artifactId),
      )

      expect([patch.status, remove.status]).toEqual([404, 404])
    })

    it('lets the owner flip visibility and records the transition once', async () => {
      await setVisibility('private')
      const before = (await auditRowsFor(artifactId)).length

      const response = await patchArtifactRoute(
        patchRequest(aliceToken, { visibility: 'org' }),
        routeContext(artifactId),
      )
      const body = (await response.json()) as ViewBody

      expect(response.status).toBe(200)
      expect(body.data.visibility).toBe('org')

      const rows = await auditRowsFor(artifactId)
      expect(rows).toHaveLength(before + 1)
      expect(rows[0]).toMatchObject({
        action: 'artifact.visibility_change',
        actorUserId: aliceId,
        metadata: { from: 'private', to: 'org' },
      })
    })

    it('accepts public over the API and records the transition to it', async () => {
      await setVisibility('org')

      const response = await patchArtifactRoute(
        patchRequest(aliceToken, { visibility: 'public' }),
        routeContext(artifactId),
      )
      const body = (await response.json()) as ViewBody

      expect(response.status).toBe(200)
      expect(body.data.visibility).toBe('public')

      const [row] = await auditRowsFor(artifactId)
      expect(row).toMatchObject({
        action: 'artifact.visibility_change',
        actorUserId: aliceId,
        metadata: { from: 'org', to: 'public' },
      })
    })

    it('422s a level the schema has never heard of', async () => {
      const response = await patchArtifactRoute(
        patchRequest(aliceToken, { visibility: 'unlisted' }),
        routeContext(artifactId),
      )

      expect(response.status).toBe(422)
    })

    it('writes no row when the visibility sent is the one already set', async () => {
      await setVisibility('org')
      const before = (await auditRowsFor(artifactId)).length

      const response = await patchArtifactRoute(
        patchRequest(aliceToken, { visibility: 'org' }),
        routeContext(artifactId),
      )

      expect(response.status).toBe(200)
      expect(await auditRowsFor(artifactId)).toHaveLength(before)
    })

    it('422s an unknown field instead of silently ignoring it', async () => {
      const response = await patchArtifactRoute(
        patchRequest(aliceToken, { visibilty: 'org' }),
        routeContext(artifactId),
      )

      expect(response.status).toBe(422)
    })

    it('422s an empty patch', async () => {
      const response = await patchArtifactRoute(patchRequest(aliceToken, {}), routeContext(artifactId))

      expect(response.status).toBe(422)
    })

    it('GETs the artifact for a member once it is org and 404s while it is private', async () => {
      await setVisibility('org')
      const readable = new Request(`${ARTIFACT_URL}/${artifactId}`, {
        headers: { authorization: `Bearer ${bobToken}` },
      })
      // An API token stays owner-scoped, so even an org artifact is a 404 for Bob's token.
      expect((await getArtifactRoute(readable, routeContext(artifactId))).status).toBe(404)

      expect(await readArtifactView(artifactId, userViewerRef(bobId))).not.toBeNull()

      await setVisibility('private')
      expect(await readArtifactView(artifactId, userViewerRef(bobId))).toBeNull()
    })
  })

  describe('the session write path', () => {
    it('404s a non-owner on a private artifact and 403s them once it is org', async () => {
      await setVisibility('private')
      await expect(
        updateArtifact({
          artifactId,
          viewerRef: userViewerRef(bobId),
          patch: { visibility: 'org' },
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })

      await setVisibility('org')
      await expect(
        updateArtifact({ artifactId, viewerRef: userViewerRef(bobId), patch: { title: 'mine now' } }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })

      await expect(
        softDeleteArtifact({ artifactId, viewerRef: userViewerRef(bobId) }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('renames and re-slugs for the owner', async () => {
      const view = await updateArtifact({
        artifactId,
        viewerRef: userViewerRef(aliceId),
        patch: { title: 'Quarterly Numbers 2026' },
      })

      expect(view.title).toBe('Quarterly Numbers 2026')
      expect(view.slug).toBe('quarterly-numbers-2026')
    })
  })

  describe('artifact.view (§5.2 — non-private only)', () => {
    it('records one row when the artifact is org', async () => {
      await setVisibility('org')
      const before = (await auditRowsFor(artifactId)).filter((row) => row.action === 'artifact.view')

      expect(await enterArtifact(userViewerRef(bobId))).toBe(302)

      const after = (await auditRowsFor(artifactId)).filter((row) => row.action === 'artifact.view')
      expect(after).toHaveLength(before.length + 1)
      expect(after[0]).toMatchObject({ action: 'artifact.view', actorUserId: bobId })
    })

    it('records one actorless row when a visitor with no session opens a public artifact', async () => {
      await setVisibility('public')
      const before = (await auditRowsFor(artifactId)).filter((row) => row.action === 'artifact.view')

      expect(await enterArtifact(ANONYMOUS_VIEWER_REF)).toBe(302)

      const after = (await auditRowsFor(artifactId)).filter((row) => row.action === 'artifact.view')
      expect(after).toHaveLength(before.length + 1)
      // The row is the timestamp and the IP: an anonymous read has no actor to name.
      expect(after[0]).toMatchObject({ action: 'artifact.view', actorUserId: null })
    })

    it('records nothing when an owner views their own private artifact', async () => {
      await setVisibility('private')
      const before = (await auditRowsFor(artifactId)).filter((row) => row.action === 'artifact.view')

      expect(await enterArtifact(userViewerRef(aliceId))).toBe(302)

      const after = (await auditRowsFor(artifactId)).filter((row) => row.action === 'artifact.view')
      expect(after).toHaveLength(before.length)
    })

    it('never stores a prompt on an audit row', async () => {
      const rows = await db
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.artifactId, artifactId), eq(auditLog.action, 'artifact.view')))

      for (const row of rows) {
        expect(Object.keys(row.metadata ?? {})).not.toContain('prompt')
      }
    })
  })

  describe('append-only enforcement', () => {
    it('refuses an UPDATE from the application', async () => {
      const refusal = await rejectionText(
        db.update(auditLog).set({ action: 'auth.login' }).where(eq(auditLog.artifactId, artifactId)),
      )

      expect(refusal).toContain('append-only')
    })

    it('refuses a DELETE from the application', async () => {
      const refusal = await rejectionText(
        db.delete(auditLog).where(eq(auditLog.artifactId, artifactId)),
      )

      expect(refusal).toContain('append-only')
    })

    it('lets only the retention job delete, and only what is past the window', async () => {
      // A fresh id per run: nothing can delete the rows a previous run left behind.
      const staleArtifactId = crypto.randomUUID()
      await db.insert(auditLog).values([
        { action: 'artifact.view', artifactId: staleArtifactId, at: sql`now() - interval '400 days'` },
        { action: 'artifact.view', artifactId: staleArtifactId },
      ])

      const result = await pruneAuditLog(365)

      expect(result.prunedRowCount).toBeGreaterThanOrEqual(1)
      expect(await auditRowsFor(staleArtifactId)).toHaveLength(1)
    })
  })
})
