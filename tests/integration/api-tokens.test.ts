import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { GET as listArtifactsRoute, POST as createArtifactRoute } from '@app/api/v1/artifacts/route'
import { db } from '@/db'
import { apiTokens, type ApiTokenScope } from '@/db/schema/api-tokens'
import { artifacts } from '@/db/schema/artifacts'
import { auditLog } from '@/db/schema/audit-log'
import { users } from '@/db/schema/users'
import { apiTokenViewerRef, authorizeArtifactRead } from '@/lib/artifacts/authorize'
import {
  createApiToken,
  hashApiToken,
  listApiTokens,
  mintApiToken,
  resolveApiToken,
  revokeApiToken,
} from '@/lib/auth/bearer'
import { resetRateLimits } from '@/lib/rate-limit'
import { createTestStore, probeServices } from './services'

/**
 * S8 against real Postgres and real object storage, through the actual route handlers. A mock
 * cannot honestly prove the things this slice is about: that a revoked row stops authenticating,
 * that expiry is compared in Postgres time, and that a token can never reach another user's rows.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/api-tokens: database=${database} storage=${storage}.`,
  )
}

const ALICE_EMAIL = 'api-token-alice@example.test'
const BOB_EMAIL = 'api-token-bob@example.test'

const INDEX_HTML = '<!doctype html><title>CI build</title>'
const ARTIFACTS_URL = 'http://app.example.com/api/v1/artifacts'

interface CreatedBody {
  readonly data: { readonly id: string; readonly versionId: string; readonly viewUrl: string }
}

interface ListBody {
  readonly data: { readonly items: ReadonlyArray<{ readonly id: string }> }
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

let aliceId = ''
let bobId = ''

async function createUser(email: string): Promise<string> {
  await db.delete(users).where(eq(users.email, email))
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (user === undefined) throw new Error(`could not create ${email}`)
  return user.id
}

async function removeUser(userId: string): Promise<void> {
  const store = createTestStore()
  const owned = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.ownerId, userId))
  for (const artifact of owned) {
    await store.deletePrefix(`artifacts/${artifact.id}/`)
  }

  await db.delete(apiTokens).where(eq(apiTokens.userId, userId))
  await db.delete(artifacts).where(eq(artifacts.ownerId, userId))
  await db.delete(users).where(eq(users.id, userId))
}

interface InsertTokenInput {
  readonly userId: string
  readonly scopes: readonly ApiTokenScope[]
  readonly expiresAt?: Date
  readonly revokedAt?: Date
}

/** Inserts directly so a test can produce states `createApiToken` deliberately cannot. */
async function insertToken(input: InsertTokenInput): Promise<string> {
  const { plaintext, tokenHash } = mintApiToken()
  await db.insert(apiTokens).values({
    userId: input.userId,
    name: 'fixture',
    tokenHash,
    scopes: [...input.scopes],
    expiresAt: input.expiresAt ?? null,
    revokedAt: input.revokedAt ?? null,
  })
  return plaintext
}

function postRequest(token: string, title = 'CI build'): Request {
  return new Request(ARTIFACTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title,
      visibility: 'private',
      files: [{ path: 'index.html', content: INDEX_HTML }],
    }),
  })
}

function getRequest(token: string): Request {
  return new Request(ARTIFACTS_URL, { headers: { authorization: `Bearer ${token}` } })
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

describe.skipIf(!servicesReady)('scoped API tokens', () => {
  beforeAll(async () => {
    aliceId = await createUser(ALICE_EMAIL)
    bobId = await createUser(BOB_EMAIL)
  })

  afterAll(async () => {
    await removeUser(aliceId)
    await removeUser(bobId)
  })

  beforeEach(() => {
    // The per-IP limiter counts failed bearer attempts; every test starts with a full budget.
    resetRateLimits()
  })

  describe('scope matrix, every scope set against every guarded endpoint', () => {
    it.each([
      [['artifacts:read'], 403, 200],
      [['artifacts:write'], 201, 403],
      [['shares:write'], 403, 403],
      [['artifacts:read', 'artifacts:write'], 201, 200],
      [['artifacts:read', 'artifacts:write', 'shares:write'], 201, 200],
    ] as ReadonlyArray<[ApiTokenScope[], number, number]>)(
      '%s gets %i from POST and %i from GET',
      async (scopes, postStatus, getStatus) => {
        const token = await insertToken({ userId: aliceId, scopes })

        expect((await createArtifactRoute(postRequest(token))).status).toBe(postStatus)
        expect((await listArtifactsRoute(getRequest(token))).status).toBe(getStatus)
      },
    )

    it('names the missing scope without echoing the token', async () => {
      const token = await insertToken({ userId: aliceId, scopes: ['artifacts:read'] })

      const response = await createArtifactRoute(postRequest(token))
      const body = (await response.json()) as ErrorBody

      expect(response.status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.message).toBe('Token lacks scope artifacts:write')
      expect(JSON.stringify(body)).not.toContain(token)
    })

    it('refuses a shares:write-only token on the artifact endpoints it does not cover', async () => {
      const token = await insertToken({ userId: aliceId, scopes: ['shares:write'] })

      expect(await errorCodeOf(await listArtifactsRoute(getRequest(token)))).toBe('FORBIDDEN')
    })
  })

  describe('rejected credentials', () => {
    it('401s a revoked token', async () => {
      const token = await insertToken({
        userId: aliceId,
        scopes: ['artifacts:read', 'artifacts:write'],
        revokedAt: new Date(),
      })

      const response = await listArtifactsRoute(getRequest(token))

      expect(response.status).toBe(401)
      expect(await errorCodeOf(response)).toBe('UNAUTHENTICATED')
    })

    it('401s an expired token', async () => {
      const token = await insertToken({
        userId: aliceId,
        scopes: ['artifacts:read'],
        expiresAt: new Date(Date.now() - 1000),
      })

      expect((await listArtifactsRoute(getRequest(token))).status).toBe(401)
    })

    it('accepts a token whose expiry is still ahead', async () => {
      const token = await insertToken({
        userId: aliceId,
        scopes: ['artifacts:read'],
        expiresAt: new Date(Date.now() + 60_000),
      })

      expect((await listArtifactsRoute(getRequest(token))).status).toBe(200)
    })

    it('401s a token whose owner was deactivated', async () => {
      const token = await insertToken({ userId: bobId, scopes: ['artifacts:read'] })
      await db.update(users).set({ isActive: false }).where(eq(users.id, bobId))

      try {
        expect((await listArtifactsRoute(getRequest(token))).status).toBe(401)
      } finally {
        await db.update(users).set({ isActive: true }).where(eq(users.id, bobId))
      }
    })

    it.each([
      ['an unknown token', `enc_${'a'.repeat(43)}`],
      ['a value without the enc_ prefix', 'not-a-token'],
    ])('401s %s', async (_case, token) => {
      expect((await listArtifactsRoute(getRequest(token))).status).toBe(401)
    })

    it('never says which of the four rejection reasons applied', async () => {
      const revoked = await insertToken({
        userId: aliceId,
        scopes: ['artifacts:read'],
        revokedAt: new Date(),
      })
      const expired = await insertToken({
        userId: aliceId,
        scopes: ['artifacts:read'],
        expiresAt: new Date(Date.now() - 1000),
      })

      const messages = await Promise.all(
        [revoked, expired, 'enc_unknown'].map(async (token) =>
          ((await (await listArtifactsRoute(getRequest(token))).json()) as ErrorBody).error.message,
        ),
      )

      expect(new Set(messages).size).toBe(1)
    })
  })

  describe('the worked example: an agent pushes a bundle', () => {
    it('creates an artifact owned by the token user and stamps last_used_at', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'ci',
        scopes: ['artifacts:write'],
      })

      const [before] = await db
        .select({ lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, created.id))
      expect(before?.lastUsedAt).toBeNull()

      const response = await createArtifactRoute(postRequest(created.plaintext, 'Agent push'))
      const body = (await response.json()) as CreatedBody

      expect(response.status).toBe(201)
      expect(body.data.viewUrl).toContain(body.data.id)

      const [artifact] = await db
        .select({ ownerId: artifacts.ownerId })
        .from(artifacts)
        .where(eq(artifacts.id, body.data.id))
      expect(artifact?.ownerId).toBe(aliceId)

      const [after] = await db
        .select({ lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, created.id))
      expect(after?.lastUsedAt).not.toBeNull()
    })

    it('advances last_used_at on every later call', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'ci-repeat',
        scopes: ['artifacts:read'],
      })

      await listArtifactsRoute(getRequest(created.plaintext))
      const [first] = await db
        .select({ lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, created.id))

      await listArtifactsRoute(getRequest(created.plaintext))
      const [second] = await db
        .select({ lastUsedAt: apiTokens.lastUsedAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, created.id))

      expect(second?.lastUsedAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
        first?.lastUsedAt?.getTime() ?? 0,
      )
    })
  })

  describe('a token acts as its owning user, never wider', () => {
    it('cannot read another user\'s private artifact', async () => {
      const aliceToken = await createApiToken({
        userId: aliceId,
        name: 'alice-write',
        scopes: ['artifacts:write'],
      })
      const created = (await (
        await createArtifactRoute(postRequest(aliceToken.plaintext, 'Alice private'))
      ).json()) as CreatedBody

      const asBob = await authorizeArtifactRead(created.data.id, apiTokenViewerRef(bobId))
      const asAlice = await authorizeArtifactRead(created.data.id, apiTokenViewerRef(aliceId))

      // `null` is what the viewer routes render as 404 — never a 403 that confirms existence.
      expect(asBob).toBeNull()
      expect(asAlice?.artifactId).toBe(created.data.id)
    })

    it('lists only the owning user\'s artifacts', async () => {
      const aliceToken = await createApiToken({
        userId: aliceId,
        name: 'alice-rw',
        scopes: ['artifacts:read', 'artifacts:write'],
      })
      const bobToken = await createApiToken({
        userId: bobId,
        name: 'bob-read',
        scopes: ['artifacts:read'],
      })

      const created = (await (
        await createArtifactRoute(postRequest(aliceToken.plaintext, 'Alice only'))
      ).json()) as CreatedBody

      const bobList = (await (
        await listArtifactsRoute(getRequest(bobToken.plaintext))
      ).json()) as ListBody
      const aliceList = (await (
        await listArtifactsRoute(getRequest(aliceToken.plaintext))
      ).json()) as ListBody

      expect(bobList.data.items.map((item) => item.id)).not.toContain(created.data.id)
      expect(aliceList.data.items.map((item) => item.id)).toContain(created.data.id)
    })
  })

  describe('token lifecycle', () => {
    it('returns the plaintext once and stores only its sha256', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'show-once',
        scopes: ['artifacts:read'],
      })

      const [stored] = await db
        .select({ tokenHash: apiTokens.tokenHash })
        .from(apiTokens)
        .where(eq(apiTokens.id, created.id))
      const listed = await listApiTokens(aliceId)

      expect(created.plaintext).toMatch(/^enc_[A-Za-z0-9_-]{43}$/)
      expect(stored?.tokenHash).toEqual(hashApiToken(created.plaintext))
      expect(JSON.stringify(listed)).not.toContain(created.plaintext)
      expect(JSON.stringify(listed)).not.toContain('token')
    })

    it('stops authenticating the moment it is revoked', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'revoke-me',
        scopes: ['artifacts:read'],
      })
      expect((await listArtifactsRoute(getRequest(created.plaintext))).status).toBe(200)

      expect(await revokeApiToken(aliceId, created.id)).toBe(true)

      expect((await listArtifactsRoute(getRequest(created.plaintext))).status).toBe(401)
      expect(await resolveApiToken(created.plaintext)).toBeNull()
    })

    it('refuses to revoke a token owned by someone else', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'not-bobs',
        scopes: ['artifacts:read'],
      })

      expect(await revokeApiToken(bobId, created.id)).toBe(false)
      expect(await resolveApiToken(created.plaintext)).not.toBeNull()
    })

    it('reports an unknown token id as not revoked', async () => {
      expect(await revokeApiToken(aliceId, '00000000-0000-4000-8000-000000000000')).toBe(false)
    })

    it('is idempotent on a second revoke', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'twice',
        scopes: ['artifacts:read'],
      })

      expect(await revokeApiToken(aliceId, created.id)).toBe(true)
      expect(await revokeApiToken(aliceId, created.id)).toBe(true)
    })
  })

  describe('audit and log hygiene', () => {
    it('writes token.create and token.revoke without the token value', async () => {
      const created = await createApiToken({
        userId: aliceId,
        name: 'audited',
        scopes: ['artifacts:write'],
        actorIp: '203.0.113.7',
      })
      await revokeApiToken(aliceId, created.id, '203.0.113.7')

      const rows = await db
        .select({ action: auditLog.action, metadata: auditLog.metadata })
        .from(auditLog)
        .where(eq(auditLog.actorUserId, aliceId))

      const actions = rows.map((row) => row.action)
      expect(actions).toContain('token.create')
      expect(actions).toContain('token.revoke')

      const serialized = JSON.stringify(rows)
      expect(serialized).toContain(created.id)
      expect(serialized).not.toContain(created.plaintext)
    })
  })
})
