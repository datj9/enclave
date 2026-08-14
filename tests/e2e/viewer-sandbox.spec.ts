import { expect, test, type APIRequestContext, type BrowserContext, type Frame, type Page } from '@playwright/test'

/**
 * The sandboxed viewer, end to end through the running app: grill-result §4.2's handoff flow and
 * §4.3's two header sets, asserted from a real browser.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on
 * an empty database. Everything below drives artifact origins through `page.goto` rather than an
 * API request context: Chrome resolves `*.localhost` to 127.0.0.1 itself, Node's resolver does
 * not. Chrome also treats `*.localhost` as a secure context, so `Secure` cookies work over http.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const APP_ORIGIN = 'http://localhost:3000'
const SESSION_COOKIE = 'enclave_session'
const GRANT_COOKIE = 'enclave_grant'

const PROBE_KEY = 'enclave-cross-probe'

interface CreatedEnvelope {
  readonly data: { readonly id: string; readonly versionId: string }
}

/** Inline script and inline style both need the artifact origin's `unsafe-inline` (§4.3). */
function indexHtml(label: string): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>Artifact</title>',
    '<link rel="stylesheet" href="assets/style.css">',
    `<p id="marker">artifact ${label}</p>`,
    '<a id="to-second-page" href="second-page.html">second page</a>',
    '<script>',
    `  localStorage.setItem('${PROBE_KEY}', '${label}');`,
    `  window.enclaveProbe = { visibleCookies: document.cookie, label: '${label}' };`,
    '</script>',
  ].join('')
}

/** Both references are relative, which is what breaks if this page is served off-origin. */
function secondPageHtml(label: string): string {
  return [
    '<!doctype html><meta charset="utf-8"><title>Second</title>',
    '<link rel="stylesheet" href="assets/style.css">',
    `<p id="second-marker">second page of ${label}</p>`,
  ].join('')
}

function bundle(label: string) {
  return {
    title: `Artifact ${label}`,
    visibility: 'private',
    files: [
      { path: 'index.html', content: indexHtml(label) },
      { path: 'second-page.html', content: secondPageHtml(label) },
      { path: 'assets/style.css', content: '#marker, #second-marker { color: rgb(0, 128, 0); }' },
      { path: 'data.json', content: JSON.stringify({ label }) },
      { path: 'assets/app.js', content: `export const label = '${label}'` },
    ],
  }
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

async function createArtifact(request: APIRequestContext, label: string): Promise<string> {
  const response = await request.post(`${APP_ORIGIN}/api/v1/artifacts`, {
    headers: { 'content-type': 'application/json' },
    data: bundle(label),
    maxRedirects: 0,
  })
  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedEnvelope).data.id
}

function artifactOrigin(artifactId: string): string {
  return `http://${artifactId}.artifacts.localhost:3000`
}

/** Opens the viewer and returns the artifact's frame once its document has actually rendered. */
async function openViewer(page: Page, artifactId: string, label: string): Promise<Frame> {
  await page.goto(`${APP_ORIGIN}/a/${artifactId}`)

  const marker = page.frameLocator('iframe[title="Artifact"]').locator('#marker')
  await expect(marker).toHaveText(`artifact ${label}`)

  const frame = page.frames().find((candidate) => candidate.url().startsWith(artifactOrigin(artifactId)))
  expect(frame, 'the artifact frame is on its own origin').toBeTruthy()
  return frame as Frame
}

async function grantCookieValue(context: BrowserContext, artifactId: string): Promise<string> {
  const cookies = await context.cookies(artifactOrigin(artifactId))
  const grant = cookies.find((cookie) => cookie.name === GRANT_COOKIE)
  expect(grant, 'the grant cookie is set on the artifact origin').toBeTruthy()
  return grant?.value ?? ''
}


test.describe.configure({ mode: 'serial' })

test.describe('sandboxed artifact viewer (US-8, US-3·AC3)', () => {
  let artifactA = ''
  let artifactB = ''

  /**
   * One signed-in context for the whole file. Sign-in is rate-limited per IP
   * (`RATE_LIMIT_AUTH_PER_IP_PER_HOUR`), so a `signIn` per test would exhaust the bucket and
   * start 429-ing the specs that run after this one.
   */
  let viewer: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser, playwright }) => {
    const request = await playwright.request.newContext()
    try {
      await signIn(request)
      artifactA = await createArtifact(request, 'A')
      artifactB = await createArtifact(request, 'B')
    } finally {
      await request.dispose()
    }

    viewer = await browser.newContext()
    await signIn(viewer.request)
    page = await viewer.newPage()
  })

  test.afterAll(async () => {
    await viewer.close()
  })

  test('serves two artifacts from two different hostnames', async () => {
    const frameA = await openViewer(page, artifactA, 'A')
    const hostA = new URL(frameA.url()).host

    const frameB = await openViewer(page, artifactB, 'B')
    const hostB = new URL(frameB.url()).host

    expect(hostA).toBe(`${artifactA}.artifacts.localhost:3000`)
    expect(hostB).toBe(`${artifactB}.artifacts.localhost:3000`)
    expect(hostA).not.toBe(hostB)
  })

  /**
   * The regression this pins: a link to a second page used to 302 onto a presigned storage URL,
   * so the browser left the artifact origin. Every relative `href` and `src` on that page then
   * re-resolved against storage without a signature, which is why the page arrived without its
   * stylesheet and why the next link from it did not arrive at all.
   *
   * The assertion is the origin, not the rendered colour: under the bundled MinIO the redirect
   * for `assets/style.css` is plain http, which the artifact CSP's `style-src … https:` refuses.
   * That is a separate defect in the http-storage default and would make a colour assertion fail
   * here for a reason that has nothing to do with this navigation.
   */
  test('a link to a second page is served from the artifact origin, not from storage', async () => {
    const frame = await openViewer(page, artifactA, 'A')

    const documentResponse = page.waitForResponse(
      (response) => response.url().endsWith('/second-page.html') && response.request().isNavigationRequest(),
    )
    await frame.locator('#to-second-page').click()

    const response = await documentResponse
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toBe('text/html; charset=utf-8')

    await expect(
      page.frameLocator('iframe[title="Artifact"]').locator('#second-marker'),
    ).toHaveText('second page of A')

    const secondPage = page
      .frames()
      .find((candidate) => candidate.url().endsWith('/second-page.html'))
    expect(secondPage, 'the second page is still framed on the artifact origin').toBeTruthy()
    expect(new URL((secondPage as Frame).url()).host).toBe(`${artifactA}.artifacts.localhost:3000`)
  })

  test("artifact A's localStorage is unreadable from artifact B", async () => {
    const pageA = await viewer.newPage()
    const pageB = await viewer.newPage()

    try {
      // Both frames are live at the same time, each on its own origin.
      const frameA = await openViewer(pageA, artifactA, 'A')
      const frameB = await openViewer(pageB, artifactB, 'B')

      const initialA = await frameA.evaluate((key: string) => localStorage.getItem(key), PROBE_KEY)
      const initialB = await frameB.evaluate((key: string) => localStorage.getItem(key), PROBE_KEY)
      expect(initialA).toBe('A')
      expect(initialB).toBe('B')

      await frameA.evaluate((key: string) => localStorage.setItem(key, 'written-by-A'), PROBE_KEY)

      // A shared artifact origin would collapse these two storage areas and B would now read
      // 'written-by-A'. This is the assertion that `allow-same-origin` is safe here.
      const seenByB = await frameB.evaluate((key: string) => localStorage.getItem(key), PROBE_KEY)
      expect(seenByB).toBe('B')

      const seenByA = await frameA.evaluate((key: string) => localStorage.getItem(key), PROBE_KEY)
      expect(seenByA).toBe('written-by-A')
    } finally {
      await pageA.close()
      await pageB.close()
    }
  })

  test('artifact JavaScript cannot read the app session cookie', async () => {
    const frame = await openViewer(page, artifactA, 'A')

    const appCookies = await viewer.cookies(APP_ORIGIN)
    expect(appCookies.map((cookie) => cookie.name)).toContain(SESSION_COOKIE)

    const visibleCookies = await frame.evaluate(() => document.cookie)
    expect(visibleCookies).toBe('')
    expect(visibleCookies).not.toContain(SESSION_COOKIE)
    // The grant cookie is HttpOnly, so the artifact cannot read its own credential either.
    expect(visibleCookies).not.toContain(GRANT_COOKIE)
  })

  test('the artifact origin sets frame-ancestors, nosniff and CORP (§4.3)', async () => {
    await openViewer(page, artifactA, 'A')
    const response = await page.goto(`${artifactOrigin(artifactA)}/`)
    expect(response?.status()).toBe(200)

    const headers = response?.headers() ?? {}
    const policy = headers['content-security-policy'] ?? ''
    expect(policy).toContain(`frame-ancestors ${APP_ORIGIN}`)
    expect(policy).toContain("base-uri 'none'")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("'unsafe-eval'")
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['cross-origin-resource-policy']).toBe('same-site')
    // The app's own DENY must not reach this origin, or the viewer could not frame it.
    expect(headers['x-frame-options']).toBeUndefined()
  })

  test('the app origin keeps a strict CSP and frames only artifact origins', async () => {
    const response = await page.goto(`${APP_ORIGIN}/a/${artifactA}`)

    const headers = response?.headers() ?? {}
    const policy = headers['content-security-policy'] ?? ''
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain('frame-src http://*.artifacts.localhost:3000')
    expect(headers['x-frame-options']).toBe('DENY')

    // §4.3's "no unsafe-inline / unsafe-eval" on the app origin, asserted where it decides
    // whether injected markup can execute. `style-src` keeps S1's `unsafe-inline`, which
    // Next.js needs for its own inline styles.
    const scriptSrc = policy.split('; ').find((directive) => directive.startsWith('script-src '))
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
  })

  test('the entry document is streamed, not redirected to storage', async () => {
    await openViewer(page, artifactA, 'A')

    const response = await page.goto(`${artifactOrigin(artifactA)}/`)
    expect(response?.status()).toBe(200)
    expect(response?.url()).toBe(`${artifactOrigin(artifactA)}/`)
    expect(response?.request().redirectedFrom()).toBeNull()
    expect(response?.headers()['content-type']).toContain('text/html')
  })

  test('an asset path redirects to a 60-second presigned URL', async () => {
    await openViewer(page, artifactA, 'A')

    const response = await page.goto(`${artifactOrigin(artifactA)}/data.json`)
    expect(response?.status()).toBe(200)
    expect(
      response?.request().redirectedFrom(),
      'the artifact origin 302s rather than proxying the bytes',
    ).toBeTruthy()

    const signed = new URL(response?.url() ?? '')
    expect(signed.host).not.toBe(`${artifactA}.artifacts.localhost:3000`)
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(signed.searchParams.get('X-Amz-Signature')).not.toBeNull()
  })

  test('a path absent from the version manifest is a 404', async () => {
    await openViewer(page, artifactA, 'A')

    const response = await page.goto(`${artifactOrigin(artifactA)}/not-in-manifest.js`)
    expect(response?.status()).toBe(404)
    // Still on the artifact origin: no presigned URL was minted, so nothing reached the bucket.
    expect(response?.url()).toBe(`${artifactOrigin(artifactA)}/not-in-manifest.js`)
    expect(response?.request().redirectedFrom()).toBeNull()
  })

  test('relative fetch from artifact JavaScript follows the redirect to storage', async () => {
    const frame = await openViewer(page, artifactA, 'A')

    const fetched = await frame.evaluate(async () => {
      const response = await fetch('./data.json')
      return (await response.json()) as { label: string }
    })

    expect(fetched.label).toBe('A')
  })

  test('a replayed handoff token is a 404', async ({ browser }) => {
    await openViewer(page, artifactA, 'A')

    const enterUrl = await page.locator('iframe[title="Artifact"]').getAttribute('src')
    expect(enterUrl).toContain('/__enter?t=')

    // A fresh context, so the replay cannot be waved through by an existing grant cookie.
    const replay = await browser.newContext()
    try {
      const replayPage = await replay.newPage()
      const response = await replayPage.goto(enterUrl ?? '')
      expect(response?.status()).toBe(404)
    } finally {
      await replay.close()
    }
  })

  test('/__enter without a token is a 404', async ({ browser }) => {
    const anonymous = await browser.newContext()
    try {
      const anonymousPage = await anonymous.newPage()
      const response = await anonymousPage.goto(`${artifactOrigin(artifactA)}/__enter`)
      expect(response?.status()).toBe(404)
    } finally {
      await anonymous.close()
    }
  })

  test('an unauthenticated request to an artifact origin is a 404 (US-3·AC3)', async ({
    browser,
  }) => {
    const anonymous = await browser.newContext()
    try {
      const anonymousPage = await anonymous.newPage()
      const response = await anonymousPage.goto(`${artifactOrigin(artifactA)}/`)
      expect(response?.status()).toBe(404)
    } finally {
      await anonymous.close()
    }
  })

  test("artifact A's grant cookie presented on artifact B's host is a 404", async ({ browser }) => {
    await openViewer(page, artifactA, 'A')
    const stolen = await grantCookieValue(viewer, artifactA)

    const attacker = await browser.newContext()
    try {
      await attacker.addCookies([
        {
          name: GRANT_COOKIE,
          value: stolen,
          domain: `${artifactB}.artifacts.localhost`,
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ])

      const attackerPage = await attacker.newPage()
      const response = await attackerPage.goto(`${artifactOrigin(artifactB)}/`)
      expect(response?.status()).toBe(404)
    } finally {
      await attacker.close()
    }
  })

  test('the internal rewrite target is not reachable on the app origin', async () => {
    const response = await page.goto(`${APP_ORIGIN}/artifact-origin/${artifactA}/enter`)
    expect(response?.status()).toBe(404)
  })
})
