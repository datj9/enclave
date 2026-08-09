import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import postgres from 'postgres'

import { hashPassword } from '../../src/lib/auth/password'

/**
 * US-3 and US-4 with two real accounts in two real browser contexts: a private artifact is a 404
 * for everyone but its owner, flipping it to Organization opens reads without opening writes, and
 * every transition leaves exactly one row in `audit_log`.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on an
 * empty database. Artifact origins are driven through `page.goto`: Chrome resolves `*.localhost`
 * itself and treats it as a secure context, Node's resolver does neither.
 */

const APP_ORIGIN = 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'
const MEMBER_EMAIL = 'second-member@example.com'
const MEMBER_PASSWORD = 'second-account-passphrase'

const INDEX_HTML = [
  '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
  '<p id="marker">shared numbers</p>',
].join('')

interface CreatedEnvelope {
  readonly data: { readonly id: string }
}

interface AuditRow {
  readonly action: string
  readonly metadata: Record<string, unknown> | null
}

function databaseClient() {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set')
  return postgres(databaseUrl, { max: 1 })
}

/** No password self-registration exists yet, so the second account is seeded directly. */
async function createMemberAccount(): Promise<void> {
  const sql = databaseClient()
  try {
    const passwordHash = await hashPassword(MEMBER_PASSWORD)
    await sql`
      insert into users (email, password_hash, role, is_active)
      values (${MEMBER_EMAIL}, ${passwordHash}, 'member', true)
      on conflict (email) do update set password_hash = excluded.password_hash, is_active = true
    `
  } finally {
    await sql.end()
  }
}

async function auditRowsFor(artifactId: string): Promise<AuditRow[]> {
  const sql = databaseClient()
  try {
    return await sql<AuditRow[]>`
      select action, metadata from audit_log where artifact_id = ${artifactId} order by id
    `
  } finally {
    await sql.end()
  }
}

async function signInAsAdmin(request: APIRequestContext): Promise<void> {
  if ((await request.get(`${APP_ORIGIN}/setup`)).status() === 200) {
    await request.post(`${APP_ORIGIN}/api/setup`, {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      maxRedirects: 0,
    })
    return
  }

  const response = await request.post(`${APP_ORIGIN}/api/auth/signin`, {
    headers: { 'content-type': 'application/json' },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

async function signInAsMember(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${APP_ORIGIN}/api/auth/signin`, {
    headers: { 'content-type': 'application/json' },
    data: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

async function createPrivateArtifact(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post(`${APP_ORIGIN}/api/v1/artifacts`, {
    headers: { 'content-type': 'application/json' },
    data: {
      title,
      visibility: 'private',
      files: [{ path: 'index.html', content: INDEX_HTML }],
    },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedEnvelope).data.id
}

function artifactOrigin(artifactId: string): string {
  return `http://${artifactId}.artifacts.localhost:3000`
}

test.describe.configure({ mode: 'serial' })

test.describe('private and org visibility across two accounts (US-3, US-4)', () => {
  let sharedArtifact = ''
  let privateArtifact = ''
  let owner: BrowserContext
  let member: BrowserContext
  let ownerPage: Page
  let memberPage: Page

  /** One sign-in per account for the whole file: the per-IP auth budget is shared with every spec. */
  test.beforeAll(async ({ browser, playwright }) => {
    const request = await playwright.request.newContext()
    try {
      await signInAsAdmin(request)
      sharedArtifact = await createPrivateArtifact(request, 'Shared numbers')
      privateArtifact = await createPrivateArtifact(request, 'Kept to myself')
    } finally {
      await request.dispose()
    }

    await createMemberAccount()

    owner = await browser.newContext()
    await signInAsAdmin(owner.request)
    ownerPage = await owner.newPage()

    member = await browser.newContext()
    await signInAsMember(member.request)
    memberPage = await member.newPage()
  })

  test.afterAll(async () => {
    await owner.close()
    await member.close()
  })

  test('a second member gets 404 on a private artifact, not 403', async () => {
    const response = await memberPage.goto(`${APP_ORIGIN}/a/${sharedArtifact}`)

    expect(response?.status()).toBe(404)
  })

  test('the owner flips it to Organization from the privacy switch', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${sharedArtifact}`)

    const onlyMe = ownerPage.getByRole('radio', { name: 'Only me' })
    const organization = ownerPage.getByRole('radio', { name: 'Organization' })
    await expect(onlyMe).toHaveAttribute('aria-checked', 'true')

    const [patchResponse] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/artifacts/${sharedArtifact}`) &&
          response.request().method() === 'PATCH',
      ),
      organization.click(),
    ])

    expect(patchResponse.status()).toBe(200)
    await expect(organization).toHaveAttribute('aria-checked', 'true')
    await expect(onlyMe).toHaveAttribute('aria-checked', 'false')
    // Only `public` is gated behind a confirmation; every other level commits on the press.
    await expect(ownerPage.getByTestId('publish-public-dialog')).not.toBeAttached()
  })

  test('the three options are equal width, so the crossfade shifts no layout', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${sharedArtifact}`)

    const widths = await ownerPage
      .getByRole('radio')
      .evaluateAll((options) =>
        options.map((option) => Math.round(option.getBoundingClientRect().width)),
      )

    expect(widths).toHaveLength(3)
    expect(new Set(widths).size).toBe(1)
  })

  test('the second member now gets 200 and the artifact renders', async () => {
    const response = await memberPage.goto(`${APP_ORIGIN}/a/${sharedArtifact}`)

    expect(response?.status()).toBe(200)
    await expect(memberPage.frameLocator('iframe[title="Artifact"]').locator('#marker')).toHaveText(
      'shared numbers',
    )
  })

  test('the second member sees no privacy switch — reading is not owning', async () => {
    await memberPage.goto(`${APP_ORIGIN}/a/${sharedArtifact}`)

    await expect(memberPage.getByRole('radiogroup')).toHaveCount(0)
  })

  test('the second member gets 403 on PATCH and on DELETE', async () => {
    const patch = await member.request.patch(`${APP_ORIGIN}/api/v1/artifacts/${sharedArtifact}`, {
      headers: { 'content-type': 'application/json' },
      data: { visibility: 'private' },
      maxRedirects: 0,
    })
    const remove = await member.request.delete(`${APP_ORIGIN}/api/v1/artifacts/${sharedArtifact}`, {
      maxRedirects: 0,
    })

    expect([patch.status(), remove.status()]).toEqual([403, 403])
  })

  test('a logged-out visitor still gets nothing from an org artifact', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()

      const origin = await page.goto(`${artifactOrigin(sharedArtifact)}/`)
      expect(origin?.status()).toBe(404)

      await page.goto(`${APP_ORIGIN}/a/${sharedArtifact}`)
      await expect(page).toHaveURL(/\/signin/)
    } finally {
      await anonymous.close()
    }
  })

  test('the visibility change is one audit row carrying before and after', async () => {
    const rows = await auditRowsFor(sharedArtifact)
    const changes = rows.filter((row) => row.action === 'artifact.visibility_change')

    expect(changes).toHaveLength(1)
    expect(changes[0]?.metadata).toMatchObject({ from: 'private', to: 'org' })
  })

  test('viewing the org artifact is audited and viewing your own private one is not', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${privateArtifact}`)
    await expect(ownerPage.frameLocator('iframe[title="Artifact"]').locator('#marker')).toHaveText(
      'shared numbers',
    )

    const sharedViews = (await auditRowsFor(sharedArtifact)).filter(
      (row) => row.action === 'artifact.view',
    )
    const privateViews = (await auditRowsFor(privateArtifact)).filter(
      (row) => row.action === 'artifact.view',
    )

    expect(sharedViews.length).toBeGreaterThanOrEqual(1)
    expect(privateViews).toHaveLength(0)
  })

  test('no audit row carries a prompt', async () => {
    const rows = [...(await auditRowsFor(sharedArtifact)), ...(await auditRowsFor(privateArtifact))]

    for (const row of rows) {
      expect(Object.keys(row.metadata ?? {})).not.toContain('prompt')
    }
  })
})
