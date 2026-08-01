import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { users } from '@/db/schema/users'
import { userProviderKeys } from '@/db/schema/user-provider-keys'
import { resetRateLimits } from '@/lib/rate-limit'
import { probeServices } from './services'

/**
 * `/api/v1/settings/keys` against real Postgres. What a unit test cannot prove and this does:
 * that the key reaches the column sealed, that no response ever carries it back, and that a
 * delete really does leave the user with nothing stored.
 */

const { database } = await probeServices()

if (!database) {
  console.warn('[enclave] skipping tests/integration/settings-keys: no database on DATABASE_URL.')
}

const API_KEY = 'sk-ant-api03-integration-key-9876543210'
const OWNER_EMAIL = 'integration-settings-keys@example.test'

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

const { DELETE, GET, POST } = await import('@app/api/v1/settings/keys/route')

function storeRequest(body: unknown): Request {
  return new Request('http://localhost:3000/api/v1/settings/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function createOwner(): Promise<string> {
  const [owner] = await db
    .insert(users)
    .values({ email: OWNER_EMAIL, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (owner === undefined) throw new Error('could not create the settings-keys test owner')
  return owner.id
}

describe.skipIf(!database)('/api/v1/settings/keys', () => {
  let ownerId = ''

  beforeEach(async () => {
    if (ownerId !== '') await cleanUp()
    ownerId = await createOwner()
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    resetRateLimits()
  })

  afterAll(async () => {
    if (ownerId !== '') await cleanUp()
  })

  async function cleanUp(): Promise<void> {
    await db.delete(userProviderKeys).where(eq(userProviderKeys.userId, ownerId))
    await db.delete(users).where(eq(users.id, ownerId))
  }

  async function storedRows() {
    return db.select().from(userProviderKeys).where(eq(userProviderKeys.userId, ownerId))
  }

  it('stores a key sealed, and answers 204 with no body', async () => {
    const response = await POST(storeRequest({ provider: 'anthropic', apiKey: API_KEY }))

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')

    const [row] = await storedRows()
    expect(row?.provider).toBe('anthropic')
    expect(row?.encryptedKey.toString('utf8')).not.toContain('sk-ant')
    expect(row?.encryptedKey.length).toBeGreaterThan(API_KEY.length)
  })

  it('returns only the provider, the last four characters and the timestamp', async () => {
    await POST(storeRequest({ provider: 'anthropic', apiKey: API_KEY }))

    const response = await GET()
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(body)).toEqual({
      data: {
        provider: 'anthropic',
        last4: '3210',
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    })
    expect(body).not.toContain(API_KEY)
    expect(body).not.toContain(API_KEY.slice(0, -4))
  })

  it('answers with null when the user has stored nothing', async () => {
    await expect((await GET()).json()).resolves.toEqual({ data: null })
  })

  it('replaces the stored key rather than accumulating one per provider', async () => {
    await POST(storeRequest({ provider: 'anthropic', apiKey: API_KEY }))
    await POST(
      storeRequest({ provider: 'openai-compatible', apiKey: 'sk-openai-0000000011112222' }),
    )

    const rows = await storedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provider).toBe('openai-compatible')

    await expect((await GET()).json()).resolves.toMatchObject({
      data: { provider: 'openai-compatible', last4: '2222' },
    })
  })

  it('deletes the stored key and stays idempotent', async () => {
    await POST(storeRequest({ provider: 'anthropic', apiKey: API_KEY }))

    expect((await DELETE()).status).toBe(204)
    expect(await storedRows()).toHaveLength(0)
    expect((await DELETE()).status).toBe(204)
    await expect((await GET()).json()).resolves.toEqual({ data: null })
  })

  it('rejects a key that is too short without echoing it', async () => {
    const response = await POST(storeRequest({ provider: 'anthropic', apiKey: 'short' }))
    const body = await response.text()

    expect(response.status).toBe(422)
    expect(JSON.parse(body)).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { fields: ['apiKey'] } },
    })
    expect(body).not.toContain('short')
    expect(await storedRows()).toHaveLength(0)
  })

  it('rejects an unknown provider', async () => {
    const response = await POST(storeRequest({ provider: 'gemini', apiKey: API_KEY }))

    expect(response.status).toBe(422)
    expect(await storedRows()).toHaveLength(0)
  })

  it('rejects a form post, so a cross-site form cannot store a key', async () => {
    const response = await POST(
      new Request('http://localhost:3000/api/v1/settings/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `provider=anthropic&apiKey=${API_KEY}`,
      }),
    )

    expect(response.status).toBe(422)
    expect(await storedRows()).toHaveLength(0)
  })

  it('rejects an unauthenticated caller on every method', async () => {
    mocks.sessionUser = null

    expect((await POST(storeRequest({ provider: 'anthropic', apiKey: API_KEY }))).status).toBe(401)
    expect((await GET()).status).toBe(401)
    expect((await DELETE()).status).toBe(401)
    expect(await storedRows()).toHaveLength(0)
  })

  it('never writes the key to a log line', async () => {
    const logged: string[] = []
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((line: unknown) => {
        logged.push(String(line))
      }),
    )

    await POST(storeRequest({ provider: 'anthropic', apiKey: API_KEY }))
    await GET()
    await DELETE()
    for (const spy of spies) spy.mockRestore()

    expect(logged.some((line) => line.includes('sk-ant'))).toBe(false)
  })
})
