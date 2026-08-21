import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { generations } from '@/db/schema/generations'
import { usageCounters } from '@/db/schema/usage-counters'
import { userProviderKeys } from '@/db/schema/user-provider-keys'
import { users } from '@/db/schema/users'
import type { Env } from '@/env'
import type * as EnvModule from '@/env'
import type * as ProvidersModule from '@/lib/providers'
import type { ArtifactProvider, UserProviderKeys } from '@/lib/providers'
import type { ErrorBody } from '@/lib/http'
import { toProviderError } from '@/lib/providers/errors'
import { storeUserProviderKey } from '@/lib/providers/user-keys'
import { utcWindowDate } from '@/lib/quota'
import type * as S3Module from '@/lib/storage/s3'
import type { ObjectStore } from '@/lib/storage/object-store'
import { createTestStore, probeServices, removeTestOwnerData } from './services'

/**
 * The §5.7 caps on the real `/api/v1/generate`, against real Postgres and real object storage,
 * with the model stubbed. What a unit test cannot prove and this does: that a denied call never
 * reaches the provider and leaves no `generations` row, that the counters are per user, and that
 * which key runs decides which daily cap applies.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration/generation-quota: database=${database} storage=${storage}.`,
  )
}

const WELL_FORMED = ['<file path="index.html">\n<!doctype html><title>Hi</title>\n</file>\n']
const OWN_KEY = 'sk-ant-api03-my-own-key-0123456789'
const INSTANCE_KEY = 'sk-ant-instance-key'
const HOUR_SECONDS = 3600

const OWNER_EMAIL = 'integration-quota-a@example.test'
const OTHER_EMAIL = 'integration-quota-b@example.test'

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
  envOverrides: {} as Record<string, number | string>,
  instanceKey: undefined as string | undefined,
  deltas: [] as string[],
  failWith: undefined as unknown,
  providerCalls: 0,
  store: undefined as ObjectStore | undefined,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

/** Limits are read through `env`, so the tests set them instead of depending on a `.env`. */
vi.mock('@/env', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>()
  return {
    ...actual,
    env: new Proxy({} as Env, {
      get: (_target, property) =>
        mocks.envOverrides[property as string] ?? actual.env[property as keyof Env],
    }),
  }
})

/**
 * Only the transport is stubbed: the real `selectProvider` still decides whose key runs, so the
 * `usedInstanceKey` flag these tests assert on is the production code path's own answer.
 */
vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof ProvidersModule>()
  return {
    ...actual,
    resolveProviderForUser: (userKeys: UserProviderKeys = {}) => ({
      ...actual.selectProvider({
        instanceAnthropicKey: mocks.instanceKey,
        instanceOpenAiKey: undefined,
        openAiBaseUrl: undefined,
        model: 'stub-model',
        userKeys,
      }),
      provider: stubProvider,
    }),
  }
})

vi.mock('@/lib/storage/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof S3Module>()
  return { ...actual, objectStore: () => mocks.store ?? actual.objectStore() }
})

const { POST } = await import('@app/api/v1/generate/route')

const stubProvider: ArtifactProvider = {
  id: 'anthropic',
  async *generate() {
    mocks.providerCalls += 1
    if (mocks.failWith !== undefined) throw mocks.failWith
    for (const delta of mocks.deltas) yield delta
  },
}

function generateRequest(prompt = 'a countdown timer'): Request {
  return new Request('http://localhost:3000/api/v1/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
}

interface GenerateResult {
  readonly status: number
  readonly retryAfterSeconds: number
  readonly errorCode: string | undefined
}

/** Drains the body so the generation finishes — and so a 429's envelope is read exactly once. */
async function generate(prompt?: string): Promise<GenerateResult> {
  const response = await POST(generateRequest(prompt))
  const body = response.body === null ? '' : await response.text()
  const parsed = response.status === 200 ? undefined : (JSON.parse(body) as ErrorBody)

  return {
    status: response.status,
    retryAfterSeconds: Number(response.headers.get('retry-after')),
    errorCode: parsed?.error.code,
  }
}

async function createUser(email: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (user === undefined) throw new Error(`could not create the quota test user ${email}`)
  return user.id
}

async function generationRowsFor(userId: string) {
  return db.select().from(generations).where(eq(generations.userId, userId))
}

async function dailyCountFor(userId: string): Promise<number> {
  const rows = await db.select().from(usageCounters).where(eq(usageCounters.userId, userId))
  const today = rows.find((row) => row.windowDate === utcWindowDate(new Date()))
  return today?.generations ?? 0
}

describe.skipIf(!servicesReady)('generation quotas', () => {
  let ownerId = ''
  let otherId = ''
  let store: ObjectStore

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await cleanUp()
    ownerId = await createUser(OWNER_EMAIL)
    otherId = await createUser(OTHER_EMAIL)
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    mocks.envOverrides = {
      RATE_LIMIT_GENERATIONS_PER_HOUR: 2,
      RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY: 2,
      QUOTA_GENERATIONS_PER_DAY: 100,
      QUOTA_GENERATIONS_PER_DAY_OWN_KEY: 1000,
    }
    mocks.instanceKey = INSTANCE_KEY
    mocks.deltas = [...WELL_FORMED]
    mocks.failWith = undefined
    mocks.providerCalls = 0
    mocks.store = undefined
  })

  afterAll(async () => {
    if (ownerId !== '') await cleanUp()
  })

  async function cleanUp(): Promise<void> {
    for (const userId of [ownerId, otherId]) {
      await db.delete(usageCounters).where(eq(usageCounters.userId, userId))
      await db.delete(userProviderKeys).where(eq(userProviderKeys.userId, userId))
      await db.delete(generations).where(eq(generations.userId, userId))
      await removeTestOwnerData(userId, store)
    }
  }

  it('allows n calls in the hour and rejects n + 1 with RATE_LIMITED', async () => {
    expect((await generate()).status).toBe(200)
    expect((await generate()).status).toBe(200)

    const denied = await generate()

    expect(denied.status).toBe(429)
    expect(denied.errorCode).toBe('RATE_LIMITED')
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(HOUR_SECONDS)
  })

  it('never reaches the provider, the generations table or the counter when it denies', async () => {
    await generate()
    await generate()
    await generate()

    expect(mocks.providerCalls).toBe(2)
    expect(await generationRowsFor(ownerId)).toHaveLength(2)
    expect(await dailyCountFor(ownerId)).toBe(2)
  })

  it('counts per user, so one user cannot spend another user’s allowance', async () => {
    await generate()
    await generate()
    expect((await generate()).status).toBe(429)

    mocks.sessionUser = { id: otherId, email: OTHER_EMAIL, role: 'member', isActive: true }

    expect((await generate()).status).toBe(200)
    expect(await dailyCountFor(otherId)).toBe(1)
    expect(await dailyCountFor(ownerId)).toBe(2)
  })

  it('rejects the call past the daily quota with QUOTA_EXCEEDED', async () => {
    mocks.envOverrides.RATE_LIMIT_GENERATIONS_PER_HOUR = 100
    mocks.envOverrides.QUOTA_GENERATIONS_PER_DAY = 1

    expect((await generate()).status).toBe(200)
    const denied = await generate()

    expect(denied.status).toBe(429)
    expect(denied.errorCode).toBe('QUOTA_EXCEEDED')
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
    expect(mocks.providerCalls).toBe(1)
    expect(await generationRowsFor(ownerId)).toHaveLength(1)
    expect(await dailyCountFor(ownerId)).toBe(1)
  })

  it('gives a user on their own key the looser daily cap, and still the hourly limit', async () => {
    mocks.envOverrides.QUOTA_GENERATIONS_PER_DAY = 1
    mocks.envOverrides.QUOTA_GENERATIONS_PER_DAY_OWN_KEY = 5
    await storeUserProviderKey(ownerId, 'anthropic', OWN_KEY, undefined)

    expect((await generate()).status).toBe(200)
    expect((await generate()).status).toBe(200)

    const rows = await generationRowsFor(ownerId)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.usedInstanceKey === false)).toBe(true)
    expect(await dailyCountFor(ownerId)).toBe(2)

    // Both hourly limits are two in this suite, so the own-key path still has one.
    const denied = await generate()
    expect(denied.status).toBe(429)
    expect(denied.errorCode).toBe('RATE_LIMITED')
  })

  it('gives a user on their own key the looser hourly limit too', async () => {
    mocks.envOverrides.RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY = 4
    await storeUserProviderKey(ownerId, 'anthropic', OWN_KEY, undefined)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await generate()).status).toBe(200)
    }

    // Past the own-key hourly limit, not the instance one it would have hit at two.
    const denied = await generate()
    expect(denied.status).toBe(429)
    expect(denied.errorCode).toBe('RATE_LIMITED')
    expect(await generationRowsFor(ownerId)).toHaveLength(4)
  })

  it('falls back to the instance key and the stricter cap when the key is deleted', async () => {
    mocks.envOverrides.RATE_LIMIT_GENERATIONS_PER_HOUR = 100
    mocks.envOverrides.QUOTA_GENERATIONS_PER_DAY = 2
    mocks.envOverrides.QUOTA_GENERATIONS_PER_DAY_OWN_KEY = 5
    await storeUserProviderKey(ownerId, 'anthropic', OWN_KEY, undefined)

    await generate()
    await db.delete(userProviderKeys).where(eq(userProviderKeys.userId, ownerId))
    await generate()

    const rows = await generationRowsFor(ownerId)
    expect(rows.map((row) => row.usedInstanceKey).sort()).toEqual([false, true])

    // The counter is at 2, which is under the own-key cap of 5 but at the instance cap.
    const denied = await generate()
    expect(denied.status).toBe(429)
    expect(denied.errorCode).toBe('QUOTA_EXCEEDED')
  })

  it('reports a rejected stored key as 400 and leaves it in place to be corrected', async () => {
    await storeUserProviderKey(ownerId, 'anthropic', OWN_KEY, undefined)
    mocks.failWith = toProviderError({ status: 401 })

    const response = await generate()

    expect(response.status).toBe(400)
    expect(response.errorCode).toBe('PROVIDER_KEY_INVALID')
    expect(
      await db.select().from(userProviderKeys).where(eq(userProviderKeys.userId, ownerId)),
    ).toHaveLength(1)
    expect(await dailyCountFor(ownerId)).toBe(0)
  })

  it('reports an unreadable stored key as 400 without calling the provider', async () => {
    await storeUserProviderKey(ownerId, 'anthropic', OWN_KEY, undefined)
    await db
      .update(userProviderKeys)
      .set({ encryptedKey: Buffer.alloc(64, 7) })
      .where(eq(userProviderKeys.userId, ownerId))

    const response = await generate()

    expect(response.status).toBe(400)
    expect(response.errorCode).toBe('PROVIDER_KEY_INVALID')
    expect(mocks.providerCalls).toBe(0)
    expect(await generationRowsFor(ownerId)).toHaveLength(0)
    expect(
      await db.select().from(userProviderKeys).where(eq(userProviderKeys.userId, ownerId)),
    ).toHaveLength(1)
  })

  it('does not spend quota on a call the provider rejected', async () => {
    await generate()
    mocks.failWith = toProviderError({ status: 401 })
    await generate()

    expect(await generationRowsFor(ownerId)).toHaveLength(2)
    expect(await dailyCountFor(ownerId)).toBe(1)
  })

  it('never writes a provider key to a log line', async () => {
    await storeUserProviderKey(ownerId, 'anthropic', OWN_KEY, undefined)
    const logged: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        logged.push(String(line))
      }),
    )

    await generate()
    mocks.failWith = toProviderError({ status: 401 })
    await generate()
    for (const spy of spies) spy.mockRestore()

    expect(logged.some((line) => line.includes('sk-ant'))).toBe(false)
  })
})
