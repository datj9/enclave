import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { GET as trashRoute } from '@app/api/v1/artifacts/trash/route'
import { db } from '@/db'
import { apiTokens } from '@/db/schema/api-tokens'
import { artifacts } from '@/db/schema/artifacts'
import { shareLinks } from '@/db/schema/share-links'
import { users } from '@/db/schema/users'
import { env } from '@/env'
import { userViewerRef } from '@/lib/artifacts/authorize'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { softDeleteArtifact } from '@/lib/artifacts/update'
import { createApiToken } from '@/lib/auth/bearer'
import { artifactPrefix, type ObjectStore } from '@/lib/storage/object-store'
import type { BundleFile } from '@/lib/bundle/validate'
import { createTestStore, probeServices } from './services'

/**
 * S21's `GET /api/v1/artifacts/trash` against real Postgres and real object storage. The two
 * things a mock cannot prove: that the owner scoping lives in the SQL rather than in a filter a
 * refactor could drop, and that `daysUntilPurge` is counted on the database clock (§7).
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/trash-listing-api: database=${database} storage=${storage}`,
  )
}

const ALICE_EMAIL = 'trash-api-alice@example.test'
const BOB_EMAIL = 'trash-api-bob@example.test'
const PAGER_EMAIL = 'trash-api-pager@example.test'

const TRASH_URL = 'http://app.example.com/api/v1/artifacts/trash'
const AGED_DAYS = 29

interface TrashItem {
  readonly id: string
  readonly title: string
  readonly visibility: string
  readonly deletedAt: string
  readonly daysUntilPurge: number
}

interface TrashBody {
  readonly data: { readonly items: readonly TrashItem[]; readonly nextCursor: string | null }
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string }
}

let store: ObjectStore
let aliceId = ''
let bobId = ''
let pagerId = ''
let aliceToken = ''
let bobToken = ''
let pagerToken = ''
let writeOnlyToken = ''

function bundle(marker: string): BundleFile[] {
  return [{ path: 'index.html', content: Buffer.from(`<!doctype html><p>${marker}`, 'utf8') }]
}

async function removeUserAndOwnedRows(userId: string): Promise<void> {
  const owned = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.ownerId, userId))
  for (const artifact of owned) {
    await store.deletePrefix(artifactPrefix(artifact.id))
  }

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

async function createArtifactFor(ownerId: string, title: string): Promise<string> {
  const created = await createArtifactWithBundle(
    { ownerId, title, visibility: 'private', files: bundle(title) },
    store,
  )
  return created.id
}

/**
 * Deletes, then pins `deleted_at` to an exact distance in the past — in Postgres, so both the
 * ordering and the countdown are still judged by the database clock.
 */
async function deleteAndAge(artifactId: string, ownerId: string, days: number): Promise<void> {
  await softDeleteArtifact({ artifactId, viewerRef: userViewerRef(ownerId) })
  await db
    .update(artifacts)
    .set({ deletedAt: sql`now() - make_interval(days => ${days})` })
    .where(eq(artifacts.id, artifactId))
}

function trashRequest(token: string, search = ''): Request {
  return new Request(`${TRASH_URL}${search}`, { headers: { authorization: `Bearer ${token}` } })
}

async function readTrash(token: string, search = ''): Promise<TrashBody['data']> {
  const response = await trashRoute(trashRequest(token, search))
  expect(response.status).toBe(200)
  return ((await response.json()) as TrashBody).data
}

describe.skipIf(!servicesReady)('S21 GET /api/v1/artifacts/trash', () => {
  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()

    aliceId = await createUser(ALICE_EMAIL)
    bobId = await createUser(BOB_EMAIL)
    pagerId = await createUser(PAGER_EMAIL)

    aliceToken = (
      await createApiToken({ userId: aliceId, name: 'trash-api-alice', scopes: ['artifacts:read'] })
    ).plaintext
    bobToken = (
      await createApiToken({ userId: bobId, name: 'trash-api-bob', scopes: ['artifacts:read'] })
    ).plaintext
    pagerToken = (
      await createApiToken({ userId: pagerId, name: 'trash-api-pager', scopes: ['artifacts:read'] })
    ).plaintext
    writeOnlyToken = (
      await createApiToken({
        userId: aliceId,
        name: 'trash-api-write-only',
        scopes: ['artifacts:write'],
      })
    ).plaintext
  })

  afterAll(async () => {
    for (const id of [aliceId, bobId, pagerId].filter((id) => id !== '')) {
      await removeUserAndOwnedRows(id)
    }
  })

  it('returns the caller’s trashed artifacts, newest deletion first', async () => {
    const oldest = await createArtifactFor(aliceId, 'Deleted three days ago')
    const middle = await createArtifactFor(aliceId, 'Deleted two days ago')
    const newest = await createArtifactFor(aliceId, 'Deleted one day ago')
    await deleteAndAge(oldest, aliceId, 3)
    await deleteAndAge(middle, aliceId, 2)
    await deleteAndAge(newest, aliceId, 1)

    const page = await readTrash(aliceToken)

    const listed = page.items.map((item) => item.id)
    expect(listed.filter((id) => [oldest, middle, newest].includes(id))).toEqual([
      newest,
      middle,
      oldest,
    ])
    expect(page.items.find((item) => item.id === newest)?.title).toBe('Deleted one day ago')
  })

  it('never shows a second user their trash, in either direction', async () => {
    const aliceArtifact = await createArtifactFor(aliceId, 'Alice’s secret')
    const bobArtifact = await createArtifactFor(bobId, 'Bob’s secret')
    await deleteAndAge(aliceArtifact, aliceId, 1)
    await deleteAndAge(bobArtifact, bobId, 1)

    const asAlice = await readTrash(aliceToken)
    const asBob = await readTrash(bobToken)

    expect(asAlice.items.map((item) => item.id)).toContain(aliceArtifact)
    expect(asAlice.items.map((item) => item.id)).not.toContain(bobArtifact)
    expect(asBob.items.map((item) => item.id)).toContain(bobArtifact)
    expect(asBob.items.map((item) => item.id)).not.toContain(aliceArtifact)
    expect(asBob.items.every((item) => item.title !== 'Alice’s secret')).toBe(true)
  })

  it('never shows a ready artifact that was never deleted', async () => {
    const live = await createArtifactFor(aliceId, 'Still live')

    const page = await readTrash(aliceToken)

    expect(page.items.map((item) => item.id)).not.toContain(live)
  })

  it(`counts daysUntilPurge from the database clock — ${AGED_DAYS} days in`, async () => {
    const aged = await createArtifactFor(aliceId, 'Nearly purged')
    await deleteAndAge(aged, aliceId, AGED_DAYS)

    const page = await readTrash(aliceToken)

    expect(page.items.find((item) => item.id === aged)?.daysUntilPurge).toBe(
      env.TRASH_RETENTION_DAYS - AGED_DAYS,
    )
  })

  it('floors daysUntilPurge at 0 once the window has run out', async () => {
    const overdue = await createArtifactFor(aliceId, 'Past the window')
    await deleteAndAge(overdue, aliceId, env.TRASH_RETENTION_DAYS + 1)

    const page = await readTrash(aliceToken)

    expect(page.items.find((item) => item.id === overdue)?.daysUntilPurge).toBe(0)
  })

  it('pages with a usable nextCursor and never repeats a row', async () => {
    const oldest = await createArtifactFor(pagerId, 'Page me third')
    const middle = await createArtifactFor(pagerId, 'Page me second')
    const newest = await createArtifactFor(pagerId, 'Page me first')
    await deleteAndAge(oldest, pagerId, 3)
    await deleteAndAge(middle, pagerId, 2)
    await deleteAndAge(newest, pagerId, 1)

    const first = await readTrash(pagerToken, '?limit=2')
    expect(first.items.map((item) => item.id)).toEqual([newest, middle])
    expect(first.nextCursor).not.toBeNull()

    const second = await readTrash(
      pagerToken,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    )
    expect(second.items.map((item) => item.id)).toEqual([oldest])
    // The lookahead saw no fourth row, so the walk ends rather than offering an empty page.
    expect(second.nextCursor).toBeNull()
  })

  it('403s a token that lacks artifacts:read', async () => {
    const response = await trashRoute(trashRequest(writeOnlyToken))

    expect(response.status).toBe(403)
    expect(((await response.json()) as ErrorBody).error.code).toBe('FORBIDDEN')
  })

  it('422s a tampered cursor rather than falling back to page one', async () => {
    const response = await trashRoute(trashRequest(aliceToken, '?cursor=not-a-cursor'))

    expect(response.status).toBe(422)
    expect(((await response.json()) as ErrorBody).error.code).toBe('VALIDATION_FAILED')
  })
})
