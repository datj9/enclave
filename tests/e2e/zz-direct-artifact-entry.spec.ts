import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
  type Response as PlaywrightResponse,
} from '@playwright/test'

/**
 * Direct artifact entry, end to end through the running app: an artifact-origin URL opened cold —
 * a paste, a bookmark, or a reload after the 30-minute grant lapsed — is sent back to `/a/{id}`
 * rather than dead-ending on the uniform 404.
 *
 * The `zz-` prefix keeps this file after `setup-and-signin.spec.ts`, which asserts `/setup` is
 * still open on an empty database. Artifact origins are driven through `page.goto` because Chrome
 * resolves `*.localhost` to 127.0.0.1 itself and treats it as a secure context; Node's resolver
 * does neither, so an APIRequestContext cannot reach these hosts.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const APP_ORIGIN = 'http://localhost:3000'

interface CreatedEnvelope {
  readonly data: { readonly id: string; readonly versionId: string }
}

function bundle(label: string) {
  return {
    title: `Artifact ${label}`,
    visibility: 'private',
    files: [
      { path: 'index.html', content: `<!doctype html><meta charset="utf-8"><title>Artifact</title><p id="marker">artifact ${label}</p>` },
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

const GRANT_COOKIE = 'enclave_grant'

/**
 * The grant-miss redirect off an artifact origin, wherever it sits in the chain.
 *
 * `redirectedFrom()` steps back one hop only, and the app origin adds hops of its own after the
 * 302 — `/a/{id}` answers a signed-out visitor with a 307 to `/signin`. Matching on the artifact
 * origin's host keeps the assertion on the hop under test.
 */
async function grantMissRedirect(
  response: PlaywrightResponse | null | undefined,
  artifactId: string,
): Promise<PlaywrightResponse | null> {
  const host = new URL(artifactOrigin(artifactId)).host
  let hop = response?.request() ?? null

  while (hop !== null) {
    if (new URL(hop.url()).host === host) {
      const hopResponse = await hop.response()
      if (hopResponse !== null && hopResponse.status() === 302) return hopResponse
    }
    hop = hop.redirectedFrom()
  }

  return null
}

/** The grant cookie for one artifact origin, or undefined when the browser holds none. */
async function grantCookie(
  context: BrowserContext,
  artifactId: string,
): Promise<string | undefined> {
  const cookies = await context.cookies(artifactOrigin(artifactId))
  return cookies.find((cookie) => cookie.name === GRANT_COOKIE)?.value
}

test.describe.configure({ mode: 'serial' })

test.describe('direct artifact entry', () => {
  let artifactId = ''

  /**
   * One signed-in context for the whole file: sign-in is rate-limited per IP
   * (`RATE_LIMIT_AUTH_PER_IP_PER_HOUR`), so a `signIn` per test would exhaust the bucket and
   * start 429-ing whatever runs next.
   */
  let viewer: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser, playwright }) => {
    const request = await playwright.request.newContext()
    try {
      await signIn(request)
      artifactId = await createArtifact(request, 'D')
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

  test('a cold paste of an artifact origin lands on the rendered artifact', async () => {
    // No grant cookie for this origin yet: the paste is the first thing this context does. The
    // app-origin session cookie is present and irrelevant, so only the grant is asserted.
    expect(await grantCookie(viewer, artifactId)).toBeUndefined()

    const response = await page.goto(`${artifactOrigin(artifactId)}/`)

    // The hop off the artifact origin names the canonical viewer page.
    const redirect = await grantMissRedirect(response, artifactId)
    expect(redirect?.status()).toBe(302)
    expect(redirect?.headers()['location']).toBe(`${APP_ORIGIN}/a/${artifactId}`)
    expect(redirect?.headers()['cache-control']).toBe('no-store')

    // /a/{id} then does what it always does — authorize, mint a handoff token, frame __enter —
    // and the artifact renders. This is the whole point of the change.
    expect(page.url()).toBe(`${APP_ORIGIN}/a/${artifactId}`)
    await expect(page.frameLocator('iframe[title="Artifact"]').locator('#marker')).toHaveText(
      'artifact D',
    )
  })

  test('the redirect is not cached, so a reload after the grant exists still works', async () => {
    // Second cold navigation to the same origin, now that a grant cookie is present: it must
    // serve the document rather than bounce again.
    const response = await page.goto(`${artifactOrigin(artifactId)}/`)

    expect(response?.status()).toBe(200)
    expect(page.url()).toBe(`${artifactOrigin(artifactId)}/`)
    await expect(page.locator('#marker')).toHaveText('artifact D')
  })

  test('an anonymous cold paste is redirected and then refused, never served', async ({
    browser,
  }) => {
    const anonymous = await browser.newContext()
    try {
      const anonymousPage = await anonymous.newPage()
      const response = await anonymousPage.goto(`${artifactOrigin(artifactId)}/`)

      const redirect = await grantMissRedirect(response, artifactId)
      expect(redirect?.status()).toBe(302)

      // The artifact is private, so the app origin sends a signed-out visitor to sign in. The
      // redirect leads to a refusal — it does not hand out bytes.
      expect(anonymousPage.url()).toBe(`${APP_ORIGIN}/signin`)
      await expect(anonymousPage.locator('#marker')).toHaveCount(0)
    } finally {
      await anonymous.close()
    }
  })

  test('an artifact origin for an id that does not exist redirects identically', async ({
    browser,
  }) => {
    const missingId = '99999999-9999-4999-8999-999999999999'
    const anonymous = await browser.newContext()
    try {
      const anonymousPage = await anonymous.newPage()
      const response = await anonymousPage.goto(`${artifactOrigin(missingId)}/`)

      // The §7 pair, from a real browser: the artifact origin has not consulted Postgres when it
      // answers, so a nonexistent id gets the same 302 to the same shape of URL as a real one.
      const redirect = await grantMissRedirect(response, missingId)
      expect(redirect?.status()).toBe(302)
      expect(redirect?.headers()['location']).toBe(`${APP_ORIGIN}/a/${missingId}`)

      // Only the app origin, which does hold the database, distinguishes the two.
      expect(anonymousPage.url()).toBe(`${APP_ORIGIN}/signin`)
    } finally {
      await anonymous.close()
    }
  })

  test('a subresource on a cold origin keeps the bare 404 and is never redirected', async ({
    browser,
  }) => {
    const anonymous = await browser.newContext()
    try {
      const anonymousPage = await anonymous.newPage()
      // Same host, fetched as a subresource rather than navigated to. Redirecting this to the app
      // origin would drop app HTML into the sandbox.
      const status = await anonymousPage.evaluate(async (url: string) => {
        const response = await fetch(url, { mode: 'cors' }).catch(() => null)
        return response === null ? 'blocked' : response.status
      }, `${artifactOrigin(artifactId)}/index.html`)

      expect(status === 404 || status === 'blocked').toBe(true)
    } finally {
      await anonymous.close()
    }
  })

  test('a framed grant miss shows the re-entry link instead of a blank frame', async ({
    browser,
  }) => {
    const blocked = await browser.newContext()
    try {
      const blockedPage = await blocked.newPage()
      // Refuse the grant cookie the way a third-party-cookie-blocking browser does, so /__enter
      // succeeds but the frame's next request arrives without a grant.
      await blockedPage.route(`${artifactOrigin(artifactId)}/__enter*`, async (route) => {
        await route.fulfill({ status: 302, headers: { location: '/' } })
      })

      await signIn(blocked.request)
      await blockedPage.goto(`${APP_ORIGIN}/a/${artifactId}`)

      const frame = blockedPage.frameLocator('iframe[title="Artifact"]')
      // The framed case gets a page with a link, not a redirect the app CSP would block.
      await expect(frame.locator(`a[href="${APP_ORIGIN}/a/${artifactId}"]`)).toHaveCount(1)
      // The top-level URL is untouched: the frame did not navigate the tab.
      expect(blockedPage.url()).toBe(`${APP_ORIGIN}/a/${artifactId}`)
    } finally {
      await blocked.close()
    }
  })
})
