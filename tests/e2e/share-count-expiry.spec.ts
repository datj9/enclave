import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test'
import postgres from 'postgres'

/**
 * Issue #30 end to end: a share link that expired without ever being revoked opens nothing, so
 * neither the Share badge nor the Delete confirmation may count it as one that does.
 *
 * The expired row is written straight to the table — `createShareLink` refuses an expiry that is
 * already in the past, which is exactly the state this file needs.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on an
 * empty database.
 */

const APP_ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

/**
 * The per-IP auth budget is one in-process counter shared by every spec in the run. Signing in from
 * a distinct forwarded address puts this file on its own counter.
 */
const OWNER_IP = '203.0.113.88'

const INDEX_HTML = [
  '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
  '<p id="marker">expiry counts</p>',
].join('')

interface CreatedEnvelope {
  readonly data: { readonly id: string }
}

interface ArtifactRow {
  readonly owner_id: string
  readonly current_version_id: string
}

function databaseClient() {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set')
  return postgres(databaseUrl, { max: 1 })
}

/** An unrevoked link whose expiry Postgres already considers past. */
async function seedExpiredShareLink(artifactId: string): Promise<void> {
  const sql = databaseClient()
  try {
    const [artifact] = await sql<ArtifactRow[]>`
      select owner_id, current_version_id from artifacts where id = ${artifactId}
    `
    if (artifact === undefined) throw new Error(`no artifact ${artifactId}`)

    await sql`
      insert into share_links (artifact_id, version_id, token_hash, created_by, expires_at)
      values (
        ${artifactId},
        ${artifact.current_version_id},
        ${Buffer.from(crypto.getRandomValues(new Uint8Array(32)))},
        ${artifact.owner_id},
        now() - interval '1 hour'
      )
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

test.describe.configure({ mode: 'serial' })

test.describe('an expired link is not counted as live (#30)', () => {
  let artifactId = ''
  let owner: BrowserContext
  let ownerPage: Page

  test.beforeAll(async ({ browser }) => {
    owner = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': OWNER_IP } })
    await signInAsAdmin(owner.request)
    ownerPage = await owner.newPage()

    const created = await owner.request.post(`${APP_ORIGIN}/api/v1/artifacts`, {
      headers: { 'content-type': 'application/json' },
      data: {
        title: 'Expired links are not live',
        visibility: 'private',
        files: [{ path: 'index.html', content: INDEX_HTML }],
      },
      maxRedirects: 0,
    })
    expect(created.status()).toBe(201)
    artifactId = ((await created.json()) as CreatedEnvelope).data.id

    // Seeded first so the live link below is the newer row, and the list — newest first — puts it
    // at the top where the revoke step reaches for it.
    await seedExpiredShareLink(artifactId)

    const live = await owner.request.post(`${APP_ORIGIN}/api/v1/artifacts/${artifactId}/shares`, {
      headers: { 'content-type': 'application/json' },
      data: {},
      maxRedirects: 0,
    })
    expect(live.status()).toBe(201)
  })

  test.afterAll(async () => {
    await owner.close()
  })

  test('the badge counts the live link and ignores the expired one', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)

    await expect(ownerPage.getByTestId('share-open')).toHaveText('Share · 1')
  })

  test('the delete confirmation names that one link in the singular', async () => {
    await ownerPage.getByTestId('delete-open').click()

    const dialog = ownerPage.getByTestId('delete-dialog')
    await expect(dialog).toContainText(
      'Its 1 live share link stops working immediately, and restoring does not bring it back.',
    )

    await dialog.getByText('Keep it').click()
    await expect(dialog).not.toBeVisible()
  })

  test('revoking the live link empties the badge and the delete confirmation', async () => {
    await ownerPage.getByTestId('share-open').click()

    const [revoked] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().includes('/api/v1/shares/') && response.request().method() === 'DELETE',
      ),
      ownerPage.getByTestId('share-revoke').first().click(),
    ])
    expect(revoked.status()).toBe(204)

    await ownerPage.getByText('Done').click()

    // The expired link is still unrevoked, so a badge that dropped its number proves the revoke
    // landed on the live one rather than on it.
    await expect(ownerPage.getByTestId('share-open')).toHaveText('Share')

    // No reload: the count the server rendered is now stale, and the dialog has to re-read it.
    await ownerPage.getByTestId('delete-open').click()

    await expect(ownerPage.getByTestId('delete-dialog')).toContainText(
      'It has no live share links.',
    )
  })
})
