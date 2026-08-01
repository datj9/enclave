import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import postgres from 'postgres'

/**
 * US-10 end to end, the whole journey in one file: an author creates an artifact, shares a pinned
 * version, deletes it, finds every door shut — the share URL, and `/a/{id}` for the author
 * themselves — restores it from the trash with both versions intact, and finds the share link
 * still dead. That last step is the deliberate one (§5.3): restore does not un-revoke links.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on an
 * empty database.
 */

const APP_ORIGIN = 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const ARTIFACT_TITLE = 'Deleted then restored'
const MARKER_ID = 'marker'

/** Its own per-IP auth budget, like every other spec: the counter is shared across the run. */
const OWNER_IP = '203.0.113.77'

function indexHtml(label: string): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
    `<p id="${MARKER_ID}">${label}</p>`,
  ].join('')
}

interface CreatedEnvelope {
  readonly data: { readonly id: string; readonly versionId: string }
}

interface IdRow {
  readonly id: string
}

interface ShareRow {
  readonly id: string
  readonly revoked_at: Date | null
}

interface ArtifactRow {
  readonly deleted_at: Date | null
}

interface AuditRow {
  readonly action: string
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

/** Seeds a newer version the way the create path leaves one: a `ready` row plus its bytes. */
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

    const [version] = await sql<IdRow[]>`
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

async function artifactRow(artifactId: string): Promise<ArtifactRow | undefined> {
  const sql = databaseClient()
  try {
    const [row] = await sql<ArtifactRow[]>`
      select deleted_at from artifacts where id = ${artifactId}
    `
    return row
  } finally {
    await sql.end()
  }
}

async function versionIdsFor(artifactId: string): Promise<string[]> {
  const sql = databaseClient()
  try {
    const rows = await sql<IdRow[]>`
      select id from artifact_versions where artifact_id = ${artifactId} order by version_no
    `
    return rows.map((row) => row.id)
  } finally {
    await sql.end()
  }
}

async function sharesFor(artifactId: string): Promise<ShareRow[]> {
  const sql = databaseClient()
  try {
    return await sql<ShareRow[]>`
      select id, revoked_at from share_links where artifact_id = ${artifactId}
    `
  } finally {
    await sql.end()
  }
}

async function auditActionsFor(artifactId: string): Promise<string[]> {
  const sql = databaseClient()
  try {
    const rows = await sql<AuditRow[]>`
      select action from audit_log where artifact_id = ${artifactId} order by id
    `
    return rows.map((row) => row.action)
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
      title: ARTIFACT_TITLE,
      visibility: 'private',
      files: [{ path: 'index.html', content: indexHtml('version one') }],
    },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedEnvelope).data
}

/** Every rejection on the share path is one 404, so the assertion is the status, not a message. */
async function statusOf(context: BrowserContext, url: string): Promise<number | undefined> {
  const page = await context.newPage()
  try {
    return (await page.goto(url))?.status()
  } finally {
    await page.close()
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('delete shuts every door, restore reopens all but the links (US-10)', () => {
  let artifactId = ''
  let pinnedVersionId = ''
  let shareUrl = ''
  let owner: BrowserContext
  let ownerPage: Page

  /** One sign-in for the whole file: the per-IP auth budget is shared with every other spec. */
  test.beforeAll(async ({ browser }) => {
    owner = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': OWNER_IP } })
    await signInAsAdmin(owner.request)
    ownerPage = await owner.newPage()

    artifactId = (await createArtifact(owner.request)).id
    // v1 came from the create call; v2 is what the link pins and what restore must bring back.
    pinnedVersionId = await seedVersion(artifactId, 2, 'version two')
  })

  test.afterAll(async () => {
    await owner.close()
  })

  test('the owner shares v2 and a logged-out visitor opens it', async ({ browser }) => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    await ownerPage.getByTestId('share-open').click()

    await ownerPage.getByLabel('Version to pin').selectOption(pinnedVersionId)
    await ownerPage.getByTestId('share-create').click()

    await expect(ownerPage.getByTestId('share-url')).toBeVisible()
    shareUrl = (await ownerPage.getByTestId('share-url').innerText()).trim()

    const anonymous = await browser.newContext()
    try {
      expect(await statusOf(anonymous, shareUrl)).toBe(200)
    } finally {
      await anonymous.close()
    }
  })

  test('the delete confirmation names the live link, then lands on the trash', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    await ownerPage.getByTestId('delete-open').click()

    const dialog = ownerPage.getByTestId('delete-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('1 live share link')

    await ownerPage.getByTestId('delete-confirm').click()

    await ownerPage.waitForURL(`${APP_ORIGIN}/trash`)
    const row = ownerPage.getByTestId('trash-row').filter({ hasText: ARTIFACT_TITLE })
    await expect(row).toBeVisible()
    await expect(row.getByTestId('trash-days')).toContainText('30 days left')

    expect((await artifactRow(artifactId))?.deleted_at).not.toBeNull()
  })

  test('the share URL 404s and so does /a/{id} for the owner', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      expect(await statusOf(anonymous, shareUrl)).toBe(404)
    } finally {
      await anonymous.close()
    }

    expect(await statusOf(owner, `${APP_ORIGIN}/a/${artifactId}`)).toBe(404)
  })

  test('it is gone from the dashboard while it sits in the trash', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/dashboard`)

    await expect(ownerPage.getByText(ARTIFACT_TITLE)).toHaveCount(0)
  })

  test('the owner restores it and both versions are still there', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/trash`)
    await ownerPage.getByTestId('trash-restore').first().click()

    await expect(ownerPage.getByTestId('trash-row').filter({ hasText: ARTIFACT_TITLE })).toHaveCount(
      0,
    )
    expect((await artifactRow(artifactId))?.deleted_at).toBeNull()

    const versionIds = await versionIdsFor(artifactId)
    expect(versionIds).toHaveLength(2)
    expect(versionIds).toContain(pinnedVersionId)

    await ownerPage.goto(`${APP_ORIGIN}/dashboard`)
    await expect(ownerPage.getByText(ARTIFACT_TITLE)).toBeVisible()

    const response = await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    expect(response?.status()).toBe(200)
    await expect(
      ownerPage.frameLocator('iframe[title="Artifact"]').locator(`#${MARKER_ID}`),
    ).toHaveText('version two')
  })

  test('the share link stays revoked after the restore', async ({ browser }) => {
    const shares = await sharesFor(artifactId)
    expect(shares).toHaveLength(1)
    expect(shares[0]?.revoked_at).not.toBeNull()

    const anonymous = await browser.newContext()
    try {
      expect(await statusOf(anonymous, shareUrl)).toBe(404)
    } finally {
      await anonymous.close()
    }
  })

  test('the journey left one delete row and one restore row behind', async () => {
    const actions = await auditActionsFor(artifactId)

    expect(actions.filter((action) => action === 'artifact.delete')).toHaveLength(1)
    expect(actions.filter((action) => action === 'artifact.restore')).toHaveLength(1)
  })
})
