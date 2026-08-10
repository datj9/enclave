import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * US-3 at its widest level: `public`. A visitor with no account, no session and no share link opens
 * the artifact's own `/a/{id}` address, and that page is the only one in the product a search
 * engine is invited to index — so its title, its canonical URL, `/robots.txt` and `/sitemap.xml`
 * are asserted here alongside the read itself.
 *
 * The file name sorts last on purpose: it signs in as the administrator, and
 * `setup-and-signin.spec.ts` needs `/setup` still open on an empty database.
 */

const APP_ORIGIN = 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const TITLE = 'Public quarterly numbers'

const INDEX_HTML = [
  '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
  '<p id="marker">open to everyone</p>',
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

test.describe.configure({ mode: 'serial' })

test.describe('public visibility, and the metadata that comes with it', () => {
  let artifactId = ''
  let owner: APIRequestContext

  test.beforeAll(async ({ playwright }) => {
    owner = await playwright.request.newContext()
    await signInAsAdmin(owner)

    const created = await owner.post(`${APP_ORIGIN}/api/v1/artifacts`, {
      headers: { 'content-type': 'application/json' },
      data: {
        title: TITLE,
        visibility: 'private',
        files: [{ path: 'index.html', content: INDEX_HTML }],
      },
      maxRedirects: 0,
    })
    expect(created.status()).toBe(201)
    artifactId = ((await created.json()) as CreatedEnvelope).data.id
  })

  test.afterAll(async () => {
    await owner.dispose()
  })

  test('a signed-out visitor is sent to sign in while it is private', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

      await expect(page).toHaveURL(/\/signin/)
    } finally {
      await anonymous.close()
    }
  })

  test('choosing Public asks first, and only the confirmation publishes', async ({ browser }) => {
    const ownerContext = await browser.newContext()
    try {
      await signInAsAdmin(ownerContext.request)
      const page = await ownerContext.newPage()
      await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

      let patchCount = 0
      page.on('request', (request) => {
        if (
          request.url().endsWith(`/api/v1/artifacts/${artifactId}`) &&
          request.method() === 'PATCH'
        ) {
          patchCount += 1
        }
      })

      await page.getByRole('radio', { name: 'Public' }).click()

      await expect(page.getByTestId('publish-public-dialog')).toBeVisible()
      // An open modal marks the rest of the page `aria-hidden`, which takes the radios out of the
      // accessibility tree `getByRole` searches — the CSS engine still reaches them.
      await expect(page.locator('[role="radio"]', { hasText: 'Public' })).toHaveAttribute(
        'aria-checked',
        'false',
      )
      expect(patchCount).toBe(0)

      const [patch] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/v1/artifacts/${artifactId}`) &&
            response.request().method() === 'PATCH',
        ),
        page.getByTestId('publish-public-confirm').click(),
      ])

      expect(patch.status()).toBe(200)
      await expect(page.getByRole('radio', { name: 'Public' })).toHaveAttribute(
        'aria-checked',
        'true',
      )
      expect(patchCount).toBe(1)
    } finally {
      await ownerContext.close()
    }
  })

  test('the same visitor now reads it with no account and no link', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      const response = await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

      expect(response?.status()).toBe(200)
      await expect(page.frameLocator('iframe[title="Artifact"]').locator('#marker')).toHaveText(
        'open to everyone',
      )
    } finally {
      await anonymous.close()
    }
  })

  test('names the artifact in its title, heading and canonical URL', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

      await expect(page).toHaveTitle(`${TITLE} · enclave`)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(`/a/${artifactId}$`),
      )
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
        'content',
        `${TITLE} · enclave`,
      )
    } finally {
      await anonymous.close()
    }
  })

  test('a public artifact is the one thing invited into an index', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      await page.goto(`${APP_ORIGIN}/a/${artifactId}`)
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /^index/)

      const robots = await (await anonymous.request.get(`${APP_ORIGIN}/robots.txt`)).text()
      expect(robots).toContain('Disallow: /s/')

      const sitemap = await (await anonymous.request.get(`${APP_ORIGIN}/sitemap.xml`)).text()
      expect(sitemap).toContain(`/a/${artifactId}`)
    } finally {
      await anonymous.close()
    }
  })

  test('taking it back closes the page and marks it noindex again', async ({ browser }) => {
    await setVisibility(owner, artifactId, 'org')

    const anonymous = await browser.newContext()
    try {
      const page = await anonymous.newPage()
      await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

      await expect(page).toHaveURL(/\/signin/)
    } finally {
      await anonymous.close()
    }

    const ownerContext = await browser.newContext()
    try {
      await signInAsAdmin(ownerContext.request)
      const page = await ownerContext.newPage()
      await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    } finally {
      await ownerContext.close()
    }
  })
})
