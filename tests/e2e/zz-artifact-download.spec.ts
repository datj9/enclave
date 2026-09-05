import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test'

/**
 * US3 end to end: the per-format download menu on the viewer page, for a viewer who does not own
 * the artifact, and the PDF flow that sources a print window from `format=html`.
 *
 * The artifact is `public` so an anonymous visitor — as non-owner a viewer as it gets — can
 * download it. The menu must be visible to them (it sits outside the owner-only toolbar). The
 * PDF row is asserted by stubbing `window.open`/`print` before the artifact page loads: the
 * component must fetch the self-contained HTML, open a print window on the blob URL, and call
 * `print()` on it — no assertions on JS-rendered content, since the inlined scripts cannot run
 * under the opener's CSP.
 *
 * The `.md` row navigates to the download route (the `attachment` header makes the browser save
 * it), which Playwright sees as a `download` event carrying the slug filename.
 *
 * The `zz-` prefix keeps this file sorted after `setup-and-signin.spec.ts` (the suite runs
 * serially, one worker, in filename order). That spec asserts `/setup` is still open on an empty
 * database, so any spec that creates the admin user — this one does, in `beforeAll` — must run
 * after it. Same convention as `zz-direct-artifact-entry.spec.ts`.
 */

const APP_ORIGIN = 'http://localhost:3000'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

interface CreatedEnvelope {
  readonly data: { readonly id: string; readonly versionId: string }
}

interface DownloadProbe {
  readonly fetches: readonly string[]
  readonly opens: readonly string[]
  readonly prints: number
}

function indexHtml(): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
    '<link rel="stylesheet" href="assets/style.css">',
    '<p id="marker">downloadable</p>',
  ].join('')
}

async function signIn(request: APIRequestContext): Promise<void> {
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

async function createPublicArtifact(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${APP_ORIGIN}/api/v1/artifacts`, {
    headers: { 'content-type': 'application/json' },
    data: {
      title: 'Download me',
      visibility: 'public',
      files: [
        { path: 'index.html', content: indexHtml() },
        { path: 'assets/style.css', content: '#marker { color: rgb(0, 128, 0); }' },
      ],
    },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedEnvelope).data.id
}

/**
 * Records every download-route fetch, every `window.open`, and every `print()`, and makes the
 * popup window a stub that prints as soon as the component wires its `load` listener. The script
 * is idempotent: the probe survives page reloads and later navigations.
 */
function installDownloadProbe(page: Page): void {
  page.addInitScript(() => {
    const state = window as unknown as Window & {
      __enclaveDownloadProbe: { fetches: string[]; opens: string[]; prints: number }
    }
    state.__enclaveDownloadProbe = { fetches: [], opens: [], prints: 0 }

    const realFetch = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : new URL(String(input)).toString()
      if (url.includes('/download')) state.__enclaveDownloadProbe.fetches.push(url)
      return realFetch(input, init)
    }

    window.open = (url?: string | URL) => {
      state.__enclaveDownloadProbe.opens.push(url === undefined ? '' : url.toString())
      const stub = {
        print: () => {
          state.__enclaveDownloadProbe.prints += 1
        },
        // The PDF flow prints on `load`; fire it so the stub proves print() is wired up.
        addEventListener: (type: string, listener: () => void) => {
          if (type === 'load') listener()
        },
        close: () => {},
      }
      return stub as unknown as Window
    }
  })
}

async function readProbe(page: Page): Promise<DownloadProbe> {
  return page.evaluate(
    () =>
      (
        window as unknown as Window & {
          __enclaveDownloadProbe: { fetches: string[]; opens: string[]; prints: number }
        }
      ).__enclaveDownloadProbe,
  )
}

test.describe.configure({ mode: 'serial' })

test.describe('per-format download for a non-owner viewer (US3)', () => {
  let artifactId = ''
  let owner: BrowserContext
  let viewer: BrowserContext
  let viewerPage: Page

  test.beforeAll(async ({ browser }) => {
    owner = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.77' } })
    await signIn(owner.request)
    artifactId = await createPublicArtifact(owner.request)

    // A fresh, logged-out browser: the "non-owner viewer" half of the story.
    viewer = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.78' } })
    viewerPage = await viewer.newPage()
  })

  test.afterAll(async () => {
    await viewer.close()
    await owner.close()
  })

  test('the menu is visible to a viewer who does not own the artifact', async () => {
    await viewerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)
    await expect(viewerPage.getByTestId('download-open')).toBeVisible()
  })

  test('downloading .md reaches the download route as a slug attachment', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    installDownloadProbe(page)
    await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

    const downloadPromise = page.waitForEvent('download')
    await page.getByTestId('download-open').click()
    await page.getByTestId('download-md').click()
    const download = await downloadPromise

    // The filename comes from the route's `Content-Disposition` header — the slug + format.
    expect(download.suggestedFilename()).toBe('download-me.md')
    await context.close()
  })

  test('the PDF row opens a print window sourced from format=html', async () => {
    installDownloadProbe(viewerPage)
    await viewerPage.goto(`${APP_ORIGIN}/a/${artifactId}`)

    await viewerPage.getByTestId('download-open').click()
    await viewerPage.getByTestId('download-pdf').click()

    // The whole PDF flow is async (fetch → object URL → load → print), so wait for the probe.
    await expect
      .poll(async () => (await readProbe(viewerPage)).prints, { timeout: 5_000 })
      .toBe(1)
    const probe = await readProbe(viewerPage)

    // The print window is sourced from the self-contained HTML download. The menu fetches the
    // route by its relative path, so the probe records it verbatim (no origin prefix).
    expect(probe.fetches).toEqual([`/a/${artifactId}/download?format=html`])
    // One object URL opened, one print on the popup.
    expect(probe.opens.length).toBe(1)
    expect(probe.opens[0]).toMatch(/^blob:/)
    // No inline error surfaced: the menu's own alert region stays quiet on the happy path.
    await expect(viewerPage.getByTestId('download-menu').getByRole('alert')).toHaveCount(0)
  })

  test('a blocked pop-up surfaces the inline alert', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.addInitScript(() => {
      window.open = () => null
    })
    await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

    await page.getByTestId('download-open').click()
    await page.getByTestId('download-pdf').click()

    await expect(page.getByRole('alert')).toHaveText(
      'The pop-up was blocked. Allow pop-ups and try again.',
    )
    await context.close()
  })

  test('a failed html fetch surfaces the inline alert', async ({ browser }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.route(
      (url) => url.pathname.endsWith('/download') && url.searchParams.get('format') === 'html',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } }),
        }),
    )
    await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

    await page.getByTestId('download-open').click()
    await page.getByTestId('download-pdf').click()

    await expect(page.getByRole('alert')).toHaveText('The PDF could not be prepared.')
    await context.close()
  })
})