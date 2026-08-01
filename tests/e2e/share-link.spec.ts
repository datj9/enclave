import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import postgres from 'postgres'

/**
 * US-5 end to end: an author shares a pinned version with somebody who has no account, that person
 * opens it in a logged-out browser, and revoking the link kills the same URL immediately.
 *
 * The artifact carries three versions and the link is pinned to v2, so "renders the pinned
 * version" is a real assertion rather than a tautology about the only version there is.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on an
 * empty database.
 */

const APP_ORIGIN = 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const MARKER_ID = 'marker'

/**
 * The per-IP auth budget is one in-process counter shared by every spec in the run, and the suite
 * already sits close to it. Signing in from a distinct forwarded address puts this file on its own
 * counter so adding it cannot push another spec into a 429.
 */
const OWNER_IP = '203.0.113.55'

function indexHtml(label: string): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
    `<p id="${MARKER_ID}">${label}</p>`,
  ].join('')
}

interface CreatedEnvelope {
  readonly data: { readonly id: string; readonly versionId: string }
}

interface VersionRow {
  readonly id: string
}

interface ShareRow {
  readonly id: string
  readonly version_id: string
  readonly view_count: number
  readonly revoked_at: Date | null
}

interface AuditRow {
  readonly action: string
  readonly actor_share_link_id: string | null
  readonly actor_ip: string | null
}

function databaseClient() {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set')
  return postgres(databaseUrl, { max: 1 })
}

function storageClient(): { client: S3Client; bucket: string } {
  const endpoint = process.env.S3_ENDPOINT
  const bucket = process.env.S3_BUCKET
  if (endpoint === undefined || bucket === undefined) throw new Error('S3_ENDPOINT is not set')

  return {
    bucket,
    client: new S3Client({
      endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    }),
  }
}

/**
 * There is no "add a version" endpoint yet (§5.3 lists one; S2 shipped creation only), so newer
 * versions are seeded the way the create path would leave them: a `ready` row plus its bytes.
 */
async function seedVersion(artifactId: string, versionNo: number, label: string): Promise<string> {
  const sql = databaseClient()
  const { client, bucket } = storageClient()

  try {
    const body = indexHtml(label)
    const [owner] = await sql<{ owner_id: string }[]>`
      select owner_id from artifacts where id = ${artifactId}
    `
    if (owner === undefined) throw new Error(`no artifact ${artifactId}`)

    const manifest = JSON.stringify([
      {
        path: 'index.html',
        bytes: Buffer.byteLength(body),
        content_type: 'text/html',
        sha256: `v${versionNo}`,
      },
    ])

    const [version] = await sql<VersionRow[]>`
      insert into artifact_versions
        (artifact_id, version_no, status, entry_path, manifest, total_bytes, file_count, created_by)
      values
        (${artifactId}, ${versionNo}, 'ready', 'index.html', ${manifest}::jsonb,
         ${Buffer.byteLength(body)}, 1, ${owner.owner_id})
      returning id
    `
    if (version === undefined) throw new Error('could not seed the version')

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `artifacts/${artifactId}/${version.id}/index.html`,
        Body: body,
        ContentType: 'text/html',
      }),
    )

    await sql`update artifacts set current_version_id = ${version.id} where id = ${artifactId}`
    return version.id
  } finally {
    await sql.end()
    client.destroy()
  }
}

async function sharesFor(artifactId: string): Promise<ShareRow[]> {
  const sql = databaseClient()
  try {
    return await sql<ShareRow[]>`
      select id, version_id, view_count, revoked_at from share_links where artifact_id = ${artifactId}
    `
  } finally {
    await sql.end()
  }
}

async function viewAuditRowsFor(artifactId: string): Promise<AuditRow[]> {
  const sql = databaseClient()
  try {
    return await sql<AuditRow[]>`
      select action, actor_share_link_id, host(actor_ip) as actor_ip
      from audit_log
      where artifact_id = ${artifactId} and action = 'artifact.view'
      order by id
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

async function createArtifact(request: APIRequestContext): Promise<CreatedEnvelope['data']> {
  const response = await request.post(`${APP_ORIGIN}/api/v1/artifacts`, {
    headers: { 'content-type': 'application/json' },
    data: {
      title: 'Shared by link',
      visibility: 'private',
      files: [{ path: 'index.html', content: indexHtml('version one') }],
    },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedEnvelope).data
}

test.describe.configure({ mode: 'serial' })

test.describe('share links open for a logged-out visitor and die on revoke (US-5)', () => {
  let artifactId = ''
  let pinnedVersionId = ''
  let shareUrl = ''
  let owner: BrowserContext
  let ownerPage: Page

  /** One sign-in for the whole file: the per-IP auth budget is shared with every other spec. */
  test.beforeAll(async ({ browser }) => {
    owner = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': OWNER_IP } })
    await signInAsAdmin(owner.request)
    await owner.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_ORIGIN })
    ownerPage = await owner.newPage()

    artifactId = (await createArtifact(owner.request)).id

    // v1 exists from the create call; v2 is what the link will pin, v3 is what it must ignore.
    pinnedVersionId = await seedVersion(artifactId, 2, 'version two')
    await seedVersion(artifactId, 3, 'version three')
  })

  test.afterAll(async () => {
    await owner.close()
  })

  test('the owner creates a link pinned to v2 from the share dialog', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    await ownerPage.getByTestId('share-open').click()

    const dialog = ownerPage.getByTestId('share-dialog')
    await expect(dialog).toBeVisible()

    await ownerPage.getByLabel('Version to pin').selectOption(pinnedVersionId)
    await ownerPage.getByTestId('share-create').click()

    await expect(ownerPage.getByTestId('share-url')).toBeVisible()
    shareUrl = (await ownerPage.getByTestId('share-url').innerText()).trim()

    expect(shareUrl.startsWith(`${APP_ORIGIN}/s/`)).toBe(true)
    // 43 base64url characters from 32 random bytes.
    expect(shareUrl.slice(`${APP_ORIGIN}/s/`.length).length).toBeGreaterThanOrEqual(43)

    const shares = await sharesFor(artifactId)
    expect(shares).toHaveLength(1)
    expect(shares[0]?.version_id).toBe(pinnedVersionId)
  })

  test('the copy button swaps its icon for a check — the one earned delight', async () => {
    const copy = ownerPage.getByTestId('share-copy')
    await expect(copy).toHaveText('Copy link')

    await copy.click()

    await expect(copy).toHaveText('Copied')
    await expect(copy).toHaveAttribute('data-copied', 'true')
  })

  test('a logged-out visitor opens the link and gets the pinned v2, not the newest v3', async ({
    browser,
  }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      const response = await page.goto(shareUrl)

      expect(response?.status()).toBe(200)
      await expect(page.frameLocator('iframe[title="Artifact"]').locator(`#${MARKER_ID}`)).toHaveText(
        'version two',
      )
      // No session was involved: the token alone carried the read.
      expect(await anonymous.cookies(APP_ORIGIN)).toHaveLength(0)
    } finally {
      await anonymous.close()
    }
  })

  test('that view is one artifact.view row carrying the link id and the viewer IP', async () => {
    const rows = await viewAuditRowsFor(artifactId)
    const shares = await sharesFor(artifactId)

    expect(rows).toHaveLength(1)
    expect(rows[0]?.actor_share_link_id).toBe(shares[0]?.id)
    expect(rows[0]?.actor_ip).not.toBeNull()
    expect(shares[0]?.view_count).toBe(1)
  })

  test('the owner revokes it and the same URL 404s immediately', async ({ browser }) => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    await ownerPage.getByTestId('share-open').click()

    const [revokeResponse] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().includes('/api/v1/shares/') && response.request().method() === 'DELETE',
      ),
      ownerPage.getByTestId('share-revoke').click(),
    ])
    expect(revokeResponse.status()).toBe(204)

    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      const response = await page.goto(shareUrl)

      expect(response?.status()).toBe(404)
    } finally {
      await anonymous.close()
    }

    expect((await sharesFor(artifactId))[0]?.revoked_at).not.toBeNull()
  })

  test('a revoked link leaves no second view row behind', async () => {
    expect(await viewAuditRowsFor(artifactId)).toHaveLength(1)
  })

  test('an unknown token 404s exactly like a revoked one', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      const response = await page.goto(`${APP_ORIGIN}/s/${'a'.repeat(43)}`)

      expect(response?.status()).toBe(404)
    } finally {
      await anonymous.close()
    }
  })
})
