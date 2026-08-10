import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

/**
 * Issue #25 end to end: setting an artifact back to `Only me` does not close the links already
 * handed out, so the owner is told how many there are before the downgrade commits — and is told
 * nothing at all when there are none.
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
const OWNER_IP = '203.0.113.77'

const INDEX_HTML = [
  '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
  '<p id="marker">only me</p>',
].join('')

interface CreatedEnvelope {
  readonly data: { readonly id: string }
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

async function setVisibility(
  request: APIRequestContext,
  artifactId: string,
  visibility: 'private' | 'org' | 'public',
): Promise<void> {
  const response = await request.patch(`${APP_ORIGIN}/api/v1/artifacts/${artifactId}`, {
    headers: { 'content-type': 'application/json' },
    data: { visibility },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(200)
}

async function createShareLink(request: APIRequestContext, artifactId: string): Promise<void> {
  const response = await request.post(`${APP_ORIGIN}/api/v1/artifacts/${artifactId}/shares`, {
    headers: { 'content-type': 'application/json' },
    data: {},
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
}

/** Counts the PATCHes this page fires, so "did not commit" is asserted rather than inferred. */
function countVisibilityPatches(page: Page, artifactId: string): () => number {
  let patchCount = 0
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/v1/artifacts/${artifactId}`) && request.method() === 'PATCH') {
      patchCount += 1
    }
  })
  return () => patchCount
}

test.describe.configure({ mode: 'serial' })

test.describe('the Only me warning counts the links it will not close (#25)', () => {
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
        title: 'Links outlive the downgrade',
        visibility: 'org',
        files: [{ path: 'index.html', content: INDEX_HTML }],
      },
      maxRedirects: 0,
    })
    expect(created.status()).toBe(201)
    artifactId = ((await created.json()) as CreatedEnvelope).data.id
  })

  test.afterAll(async () => {
    await owner.close()
  })

  test('with no links, Only me commits straight through and warns about nothing', async () => {
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    const patches = countVisibilityPatches(ownerPage, artifactId)

    const [patch] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/artifacts/${artifactId}`) &&
          response.request().method() === 'PATCH',
      ),
      ownerPage.getByRole('radio', { name: 'Only me' }).click(),
    ])

    expect(patch.status()).toBe(200)
    await expect(ownerPage.getByTestId('privacy-private-dialog')).not.toBeAttached()
    await expect(ownerPage.getByRole('radio', { name: 'Only me' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(ownerPage.locator('#privacy-hint-private')).toHaveText('Nobody can browse to it.')
    expect(patches()).toBe(1)
  })

  test('with one live link, Only me asks first and does not commit on cancel', async () => {
    await setVisibility(owner.request, artifactId, 'org')
    await createShareLink(owner.request, artifactId)
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    const patches = countVisibilityPatches(ownerPage, artifactId)

    await ownerPage.getByRole('radio', { name: 'Only me' }).click()

    const dialog = ownerPage.getByTestId('privacy-private-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(
      '1 share link still opens this artifact. Setting it to Only me does not close it — revoke it in Share.',
    )
    // An open modal marks the rest of the page `aria-hidden`, which takes the radios out of the
    // accessibility tree `getByRole` searches — the CSS engine still reaches them.
    await expect(ownerPage.locator('[role="radio"]', { hasText: 'Only me' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(patches()).toBe(0)

    await dialog.getByText('Keep it as it is').click()

    await expect(dialog).not.toBeVisible()
    expect(patches()).toBe(0)
  })

  test('confirming commits once and the hint then names the link', async () => {
    const patches = countVisibilityPatches(ownerPage, artifactId)

    await ownerPage.getByRole('radio', { name: 'Only me' }).click()
    await expect(ownerPage.getByTestId('privacy-private-dialog')).toBeVisible()

    const [patch] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/artifacts/${artifactId}`) &&
          response.request().method() === 'PATCH',
      ),
      ownerPage.getByTestId('privacy-private-confirm').click(),
    ])

    expect(patch.status()).toBe(200)
    await expect(ownerPage.getByRole('radio', { name: 'Only me' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await expect(ownerPage.locator('#privacy-hint-private')).toHaveText(
      'Nobody can browse to it. 1 share link still opens it — revoke it in Share.',
    )
    expect(patches()).toBe(1)
  })

  test('revoking the link in Share leaves the next downgrade with nothing to ask about', async () => {
    await setVisibility(owner.request, artifactId, 'org')
    await ownerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)

    await ownerPage.getByTestId('share-open').click()
    const [revoked] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().includes('/api/v1/shares/') && response.request().method() === 'DELETE',
      ),
      ownerPage.getByTestId('share-revoke').click(),
    ])
    expect(revoked.status()).toBe(204)
    await ownerPage.getByText('Done').click()

    // No reload: the count the server rendered is now stale, and the switch has to re-read it.
    const [patch] = await Promise.all([
      ownerPage.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/v1/artifacts/${artifactId}`) &&
          response.request().method() === 'PATCH',
      ),
      ownerPage.getByRole('radio', { name: 'Only me' }).click(),
    ])

    expect(patch.status()).toBe(200)
    await expect(ownerPage.getByTestId('privacy-private-dialog')).not.toBeAttached()
    await expect(ownerPage.locator('#privacy-hint-private')).toHaveText('Nobody can browse to it.')
  })
})
