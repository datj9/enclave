import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as appendVersionRoute } from '@app/api/v1/artifacts/[id]/versions/route'
import { db } from '@/db'
import { apiTokens, type ApiTokenScope } from '@/db/schema/api-tokens'
import { artifacts } from '@/db/schema/artifacts'
import { users } from '@/db/schema/users'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { artifactViewUrl } from '@/lib/artifacts/naming'
import { mintApiToken } from '@/lib/auth/bearer'
import { resetRateLimits } from '@/lib/rate-limit'
import type { BundleFile } from '@/lib/bundle/validate'
import {
  createTestOwner,
  createTestStore,
  probeServices,
  removeTestOwnerData,
} from './services'

/**
 * `POST /api/v1/artifacts/{id}/versions` against real Postgres and real object storage, through the
 * actual route handler. Mirrors the S15 append contract: version N+1 at the same `viewUrl`, the
 * `expectedVersionNo` guard refusing a lost race with 409, and artifact properties rejected — they
 * move through `PATCH`, not a push.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/artifact-versions-route: database=${database} storage=${storage}.`,
  )
}

const INDEX_HTML = '<!doctype html><script src=./app.js></script>'
const APP_JS = 'console.log(1)'

// Vitest runs test files in parallel against one Postgres: `createTestOwner` with an email of its
// own is what keeps this file's rows from being deleted by `artifact-store.test.ts`, which owns
// the shared `TEST_OWNER_EMAIL`.
const VERSIONS_ROUTE_OWNER_EMAIL = 'integration-version-route@example.test'
const STRANGER_EMAIL = 'integration-version-route-stranger@example.test'

function bundle(): BundleFile[] {
  return [
    { path: 'index.html', content: Buffer.from(INDEX_HTML, 'utf8') },
    { path: 'app.js', content: Buffer.from(APP_JS, 'utf8') },
  ]
}

/** The JSON-serializable body shape the HTTP route parses: string content, never Buffer. */
function bundleBody(): readonly { readonly path: string; readonly content: string }[] {
  return [
    { path: 'index.html', content: INDEX_HTML },
    { path: 'app.js', content: APP_JS },
  ]
}

interface AppendedBody {
  readonly data: { readonly versionId: string; readonly versionNo: number; readonly viewUrl: string }
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

interface ValidationErrorBody {
  readonly error: {
    readonly code: string
    readonly details: { readonly fields: readonly string[] }
  }
}

/** Inserts a token directly, returning the one-time plaintext, like the api-tokens suite does. */
async function insertToken(userId: string, scopes: readonly ApiTokenScope[]): Promise<string> {
  const { plaintext, tokenHash } = mintApiToken()
  await db.insert(apiTokens).values({
    userId,
    name: 'versions-route-fixture',
    tokenHash,
    scopes: [...scopes],
    expiresAt: null,
    revokedAt: null,
  })
  return plaintext
}

async function createStrangerOwner(): Promise<string> {
  await db.delete(users).where(eq(users.email, STRANGER_EMAIL))

  const [owner] = await db
    .insert(users)
    .values({ email: STRANGER_EMAIL, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (owner === undefined) throw new Error('could not create the stranger owner')
  return owner.id
}

function appendRequest(
  artifactId: string,
  token: string,
  body: unknown,
): Request {
  return new Request(`http://app.example.com/api/v1/artifacts/${artifactId}/versions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

async function errorCodeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

describe.skipIf(!servicesReady)('POST /api/v1/artifacts/[id]/versions', () => {
  let store: ReturnType<typeof createTestStore>
  let ownerId = ''
  let strangerId = ''
  let token = ''
  let artifactId = ''

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    ownerId = await createTestOwner(VERSIONS_ROUTE_OWNER_EMAIL)
    strangerId = await createStrangerOwner()
    token = await insertToken(ownerId, ['artifacts:write'])
    // The per-IP limiter counts failed bearer attempts; every test starts with a full budget.
    resetRateLimits()
    artifactId = ''

    const created = await createArtifactWithBundle(
      { ownerId, title: 'Sales dash', visibility: 'private', files: bundle() },
      store,
    )
    artifactId = created.id
  })

  afterAll(async () => {
    if (ownerId !== '') await removeTestOwnerData(ownerId, store)
    await db.delete(users).where(eq(users.email, STRANGER_EMAIL))
  })

  async function cleanupOwnedRows(): Promise<void> {
    if (ownerId === '') return

    const owned = await db.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.ownerId, ownerId))
    for (const artifact of owned) await store.deletePrefix(`artifacts/${artifact.id}/`)

    const [stranger] = await db.select({ id: users.id }).from(users).where(eq(users.email, STRANGER_EMAIL))

    // FK order: api_tokens references users, and every artifact_versions row references both the
    // artifact and the user. Deleting artifacts cascades to their versions; the users rows go last.
    await db.delete(apiTokens).where(eq(apiTokens.userId, ownerId))
    if (stranger !== undefined) await db.delete(apiTokens).where(eq(apiTokens.userId, stranger.id))
    await db.delete(artifacts).where(eq(artifacts.ownerId, ownerId))
    await db.delete(users).where(eq(users.id, ownerId))
    await db.delete(users).where(eq(users.email, STRANGER_EMAIL))
  }

  it('appends version 2 and answers 201 with the {data} envelope', async () => {
    const response = await appendVersionRoute(appendRequest(artifactId, token, { files: bundleBody() }), {
      params: Promise.resolve({ id: artifactId }),
    })
    const body = (await response.json()) as AppendedBody

    expect(response.status).toBe(201)
    expect(body.data).toEqual({
      versionId: expect.any(String) as string,
      versionNo: 2,
      viewUrl: artifactViewUrl(artifactId),
    })
  })

  it('409s with both version numbers when expectedVersionNo does not match', async () => {
    const response = await appendVersionRoute(
      appendRequest(artifactId, token, { files: bundleBody(), expectedVersionNo: 2 }),
      { params: Promise.resolve({ id: artifactId }) },
    )
    const body = (await response.json()) as {
      readonly error: { readonly code: string; readonly details: Record<string, unknown> }
    }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('VERSION_CONFLICT')
    expect(body.error.details).toEqual({ expectedVersionNo: 2, currentVersionNo: 1 })
  })

  it('appends unconditionally when expectedVersionNo is omitted', async () => {
    const response = await appendVersionRoute(appendRequest(artifactId, token, { files: bundleBody() }), {
      params: Promise.resolve({ id: artifactId }),
    })
    const body = (await response.json()) as AppendedBody

    expect(response.status).toBe(201)
    expect(body.data.versionNo).toBe(2)
  })

  it('404s for an artifact owned by somebody else, never 403', async () => {
    const strangerToken = await insertToken(strangerId, ['artifacts:write'])

    const response = await appendVersionRoute(
      appendRequest(artifactId, strangerToken, { files: bundleBody() }),
      { params: Promise.resolve({ id: artifactId }) },
    )

    expect(response.status).toBe(404)
    expect(await errorCodeOf(response)).toBe('NOT_FOUND')
  })

  it('404s for a soft-deleted (trashed) artifact', async () => {
    await db
      .update(artifacts)
      .set({ deletedAt: sql`now()` })
      .where(eq(artifacts.id, artifactId))

    const response = await appendVersionRoute(appendRequest(artifactId, token, { files: bundleBody() }), {
      params: Promise.resolve({ id: artifactId }),
    })

    expect(response.status).toBe(404)
    expect(await errorCodeOf(response)).toBe('NOT_FOUND')
  })

  it('403s a token that lacks artifacts:write, scoped shares:write only', async () => {
    const sharesOnlyToken = await insertToken(ownerId, ['shares:write'])

    const response = await appendVersionRoute(
      appendRequest(artifactId, sharesOnlyToken, { files: bundleBody() }),
      { params: Promise.resolve({ id: artifactId }) },
    )
    const body = (await response.json()) as ErrorBody

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toBe('Token lacks scope artifacts:write')
  })

  it.each(['title', 'visibility'] as const)(
    '422s and names %s in details.fields when the body carries it',
    async (forbiddenKey) => {
      const body = { files: bundleBody(), [forbiddenKey]: forbiddenKey === 'title' ? 'Pushed' : 'public' }
      const response = await appendVersionRoute(appendRequest(artifactId, token, body), {
        params: Promise.resolve({ id: artifactId }),
      })
      const parsed = (await response.json()) as ValidationErrorBody

      expect(response.status).toBe(422)
      expect(parsed.error.code).toBe('VALIDATION_FAILED')
      expect(parsed.error.details.fields).toContain(forbiddenKey)
    },
  )

  afterEach(async () => {
    await cleanupOwnedRows()
  })
})
