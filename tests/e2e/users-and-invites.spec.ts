import { expect, test, type APIRequestContext, type BrowserContext } from '@playwright/test'
import postgres from 'postgres'

import { hashPassword } from '../../src/lib/auth/password'

/**
 * S10 end to end: the admin exclusion (US-11), invite-only registration (decision #25), and the
 * deactivation flow. `ALLOW_OPEN_REGISTRATION` is false in `.env`, which is the shipped default
 * and the configuration every assertion below is written against.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on an
 * empty database — this spec needs the administrator that file creates.
 */

const APP_ORIGIN = 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'
const ALICE_EMAIL = 'invite-alice@example.com'
const ALICE_PASSWORD = 'alice-account-passphrase'
const DAVE_EMAIL = 'invite-dave@example.com'
const DAVE_PASSWORD = 'dave-account-passphrase'

const INDEX_HTML = '<!doctype html><meta charset="utf-8"><title>Artifact</title><p id="marker">numbers</p>'

/**
 * Each account presents its own client address, so this file's sign-ins draw on their own per-IP
 * auth budget rather than the suite-wide one (§8: login is rate-limited per email *and* per IP,
 * and `RATE_LIMIT_AUTH_PER_IP_PER_HOUR` is shared across every spec that signs in).
 */
function asClient(address: string) {
  return { extraHTTPHeaders: { 'x-forwarded-for': address } }
}

const ADMIN_CLIENT = '203.0.113.10'
const ALICE_CLIENT = '203.0.113.11'
const DAVE_CLIENT = '203.0.113.12'
const STRANGER_CLIENT = '203.0.113.13'

interface CreatedArtifact {
  readonly data: { readonly id: string }
}

interface CreatedInvite {
  readonly data: { readonly inviteId: string; readonly token: string; readonly url: string }
}

interface UserList {
  readonly data: { readonly items: ReadonlyArray<{ readonly id: string; readonly email: string }> }
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: Record<string, unknown>
  }
}

function databaseClient() {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set')
  return postgres(databaseUrl, { max: 1 })
}

/** Alice predates invites in this instance's history, so she is seeded rather than invited. */
async function seedAlice(): Promise<void> {
  const sql = databaseClient()
  try {
    const passwordHash = await hashPassword(ALICE_PASSWORD)
    await sql`
      insert into users (email, password_hash, role, is_active)
      values (${ALICE_EMAIL}, ${passwordHash}, 'member', true)
      on conflict (email) do update set password_hash = excluded.password_hash, is_active = true
    `
  } finally {
    await sql.end()
  }
}

async function signIn(request: APIRequestContext, email: string, password: string): Promise<void> {
  const response = await request.post(`${APP_ORIGIN}/api/auth/signin`, {
    headers: { 'content-type': 'application/json' },
    data: { email, password },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

async function createArtifact(
  request: APIRequestContext,
  title: string,
  visibility: 'private' | 'org',
): Promise<string> {
  const response = await request.post(`${APP_ORIGIN}/api/v1/artifacts`, {
    headers: { 'content-type': 'application/json' },
    data: { title, visibility, files: [{ path: 'index.html', content: INDEX_HTML }] },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedArtifact).data.id
}

test.describe.configure({ mode: 'serial' })

test.describe('invites, the admin console, and the admin exclusion (US-11)', () => {
  let admin: BrowserContext
  let alice: BrowserContext
  let dave: BrowserContext
  let privateArtifactId = ''
  let orgArtifactId = ''
  let inviteUrl = ''
  let inviteToken = ''
  let aliceId = ''

  test.beforeAll(async ({ browser }) => {
    await seedAlice()

    admin = await browser.newContext(asClient(ADMIN_CLIENT))
    await signIn(admin.request, ADMIN_EMAIL, ADMIN_PASSWORD)

    alice = await browser.newContext(asClient(ALICE_CLIENT))
    await signIn(alice.request, ALICE_EMAIL, ALICE_PASSWORD)

    privateArtifactId = await createArtifact(alice.request, 'Board compensation review', 'private')
    orgArtifactId = await createArtifact(alice.request, 'Shared numbers', 'org')

    dave = await browser.newContext(asClient(DAVE_CLIENT))
  })

  test.afterAll(async () => {
    await admin.close()
    await alice.close()
    await dave.close()
  })

  test('an admin gets 404 on another user’s private artifact, not 403', async () => {
    const response = await admin.request.get(`${APP_ORIGIN}/api/v1/artifacts/${privateArtifactId}`, {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(404)
    // A 403 would confirm the artifact exists; the whole point of branch 6 is that it does not.
    expect((await response.json()) as ErrorEnvelope).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  test('the admin still reads an org-visible artifact, like any other member', async () => {
    const response = await admin.request.get(`${APP_ORIGIN}/api/v1/artifacts/${orgArtifactId}`, {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(200)
  })

  test('no admin route hands the admin the private artifact’s title', async () => {
    const users = await admin.request.get(`${APP_ORIGIN}/api/v1/users`)
    const audit = await admin.request.get(
      `${APP_ORIGIN}/api/v1/audit?artifactId=${privateArtifactId}`,
    )

    expect([users.status(), audit.status()]).toEqual([200, 200])
    expect(await users.text()).not.toContain('Board compensation review')
    expect(await audit.text()).not.toContain('Board compensation review')
  })

  test('the audit viewer does show that the private artifact exists, by id', async () => {
    const response = await admin.request.get(
      `${APP_ORIGIN}/api/v1/audit?artifactId=${privateArtifactId}&action=artifact.create`,
    )

    expect(response.status()).toBe(200)
    expect(await response.text()).toContain(privateArtifactId)
  })

  test('a non-admin gets 403 on every admin route', async () => {
    const responses = await Promise.all([
      alice.request.get(`${APP_ORIGIN}/api/v1/users`, { maxRedirects: 0 }),
      alice.request.get(`${APP_ORIGIN}/api/v1/audit`, { maxRedirects: 0 }),
      alice.request.get(`${APP_ORIGIN}/api/v1/invites`, { maxRedirects: 0 }),
      alice.request.post(`${APP_ORIGIN}/api/v1/invites`, {
        headers: { 'content-type': 'application/json' },
        data: {},
        maxRedirects: 0,
      }),
    ])

    expect(responses.map((response) => response.status())).toEqual([403, 403, 403, 403])
  })

  test('the admin console is not reachable by a member', async () => {
    const page = await alice.newPage()
    try {
      const response = await page.goto(`${APP_ORIGIN}/admin/users`)

      expect(response?.status()).toBe(404)
    } finally {
      await page.close()
    }
  })

  test('/signup 404s without an invite while registration is invite-only', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()

      expect((await page.goto(`${APP_ORIGIN}/signup`))?.status()).toBe(404)
      expect((await page.goto(`${APP_ORIGIN}/signup?t=inv_not-a-real-token-value`))?.status()).toBe(404)
    } finally {
      await anonymous.close()
    }
  })

  test('the admin creates an invite and the link is shown exactly once', async () => {
    const response = await admin.request.post(`${APP_ORIGIN}/api/v1/invites`, {
      headers: { 'content-type': 'application/json' },
      data: { email: DAVE_EMAIL, expiresInHours: 72 },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(201)
    const created = (await response.json()) as CreatedInvite
    inviteUrl = created.data.url
    inviteToken = created.data.token
    expect(inviteUrl).toContain('/signup?t=')

    const listed = await admin.request.get(`${APP_ORIGIN}/api/v1/invites`)
    expect(await listed.text()).not.toContain(inviteToken)
  })

  test('the invite link opens the signup form', async () => {
    const page = await dave.newPage()
    try {
      const response = await page.goto(inviteUrl.replace('http://localhost:3000', APP_ORIGIN))

      expect(response?.status()).toBe(200)
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
      await expect(page.getByText(DAVE_EMAIL)).toBeVisible()
    } finally {
      await page.close()
    }
  })

  test('redeeming the invite creates the member and signs them in', async () => {
    const response = await dave.request.post(`${APP_ORIGIN}/api/auth/signup`, {
      headers: { 'content-type': 'application/json' },
      data: { inviteToken, email: DAVE_EMAIL, password: DAVE_PASSWORD },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(303)
    expect(response.headers()['location']).toBe('/dashboard')

    const page = await dave.newPage()
    try {
      await page.goto(`${APP_ORIGIN}/dashboard`)
      await expect(page.getByText(DAVE_EMAIL)).toBeVisible()
    } finally {
      await page.close()
    }
  })

  test('a second redemption of the same invite is 410', async ({ playwright }) => {
    const stranger = await playwright.request.newContext(asClient(STRANGER_CLIENT))
    try {
      const response = await stranger.post(`${APP_ORIGIN}/api/auth/signup`, {
        headers: { 'content-type': 'application/json' },
        data: { inviteToken, email: 'invite-eve@example.com', password: 'eve-account-passphrase' },
        maxRedirects: 0,
      })

      expect(response.status()).toBe(410)
      expect((await response.json()) as ErrorEnvelope).toMatchObject({
        error: { code: 'VALIDATION_FAILED', message: 'This invite has already been used' },
      })
    } finally {
      await stranger.dispose()
    }
  })

  test('the spent invite link now 404s', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      const response = await page.goto(inviteUrl.replace('http://localhost:3000', APP_ORIGIN))

      expect(response?.status()).toBe(404)
    } finally {
      await anonymous.close()
    }
  })

  test('deleting a user who owns artifacts is refused with 409 naming them', async () => {
    const roster = (await (await admin.request.get(`${APP_ORIGIN}/api/v1/users`)).json()) as UserList
    aliceId = roster.data.items.find((person) => person.email === ALICE_EMAIL)?.id ?? ''
    expect(aliceId).not.toBe('')

    const response = await admin.request.delete(`${APP_ORIGIN}/api/v1/users/${aliceId}`, {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(409)
    const body = (await response.json()) as ErrorEnvelope
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details?.['blockingArtifactIds']).toEqual(
      expect.arrayContaining([privateArtifactId, orgArtifactId]),
    )
  })

  test('deactivating Alice 401s her next request', async () => {
    const patched = await admin.request.patch(`${APP_ORIGIN}/api/v1/users/${aliceId}`, {
      headers: { 'content-type': 'application/json' },
      data: { isActive: false },
      maxRedirects: 0,
    })
    expect(patched.status()).toBe(200)

    const afterwards = await alice.request.get(`${APP_ORIGIN}/api/v1/artifacts`, { maxRedirects: 0 })
    expect(afterwards.status()).toBe(401)
  })

  test('her org-visible artifact stays visible to everyone else', async () => {
    const response = await dave.request.get(`${APP_ORIGIN}/api/v1/artifacts/${orgArtifactId}`, {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(200)
  })

  test('her private artifact is still nobody else’s to read', async () => {
    const response = await dave.request.get(`${APP_ORIGIN}/api/v1/artifacts/${privateArtifactId}`, {
      maxRedirects: 0,
    })

    expect(response.status()).toBe(404)
  })

  test('the deactivation is in the audit log the console reads', async () => {
    const response = await admin.request.get(`${APP_ORIGIN}/api/v1/audit?action=user.deactivate`)

    expect(response.status()).toBe(200)
    expect(await response.text()).toContain(aliceId)
  })
})
