import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'

/**
 * `POST /api/v1/artifacts` and the dashboard list, end to end through the running app.
 *
 * The file name sorts after `setup-and-signin.spec.ts` on purpose: Playwright runs spec files in
 * path order with one worker, and that spec asserts `/setup` is still open on an empty database.
 * `signIn` below still creates the admin if it has to, so this file also passes on its own.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const INDEX_HTML = '<!doctype html><title>Sales dash</title><script src=./app.js></script>'

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string }
}

interface CreatedEnvelope {
  readonly data: { readonly id: string; readonly versionId: string; readonly viewUrl: string }
}

interface ListEnvelope {
  readonly data: {
    readonly items: ReadonlyArray<{ readonly id: string; readonly title: string }>
    readonly nextCursor: string | null
  }
}

async function errorBody(response: APIResponse): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope
}

async function signIn(request: APIRequestContext): Promise<void> {
  if ((await request.get('/setup')).status() === 200) {
    await request.post('/api/setup', {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      maxRedirects: 0,
    })
    return
  }

  const response = await request.post('/api/auth/signin', {
    headers: { 'content-type': 'application/json' },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

function bundle(files: ReadonlyArray<{ path: string; content: string }>) {
  return { title: 'Sales dash', visibility: 'private', files }
}

async function postBundle(request: APIRequestContext, body: unknown): Promise<APIResponse> {
  return request.post('/api/v1/artifacts', {
    headers: { 'content-type': 'application/json' },
    data: body,
    maxRedirects: 0,
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('artifacts API and dashboard list', () => {
  test('rejects an unauthenticated create with 401', async ({ playwright }) => {
    // A fresh context, so no session cookie from the shared one leaks in.
    const anonymous = await playwright.request.newContext()
    try {
      const response = await postBundle(anonymous, bundle([{ path: 'index.html', content: 'hi' }]))

      expect(response.status()).toBe(401)
      expect((await errorBody(response)).error.code).toBe('UNAUTHENTICATED')
    } finally {
      await anonymous.dispose()
    }
  })

  test('rejects an unauthenticated list with 401', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext()
    try {
      expect((await anonymous.get('/api/v1/artifacts')).status()).toBe(401)
    } finally {
      await anonymous.dispose()
    }
  })

  test('creates an artifact and returns id, versionId and viewUrl', async ({ request }) => {
    await signIn(request)

    const response = await postBundle(
      request,
      bundle([
        { path: 'index.html', content: INDEX_HTML },
        { path: 'app.js', content: 'console.log(1)' },
      ]),
    )

    expect(response.status()).toBe(201)
    const body = (await response.json()) as CreatedEnvelope
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.data.versionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.data.viewUrl).toContain(body.data.id)
    expect(body.data.viewUrl.endsWith('/')).toBe(true)
  })

  test.describe('bundle rejections (US-6)', () => {
    test('a traversal path is 422 PATH_INVALID', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(
        request,
        bundle([
          { path: 'index.html', content: INDEX_HTML },
          { path: '../../etc/passwd', content: 'root:x:0:0' },
        ]),
      )

      expect(response.status()).toBe(422)
      expect((await errorBody(response)).error.code).toBe('PATH_INVALID')
    })

    test('51 files is 413 BUNDLE_TOO_LARGE', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(
        request,
        bundle([
          { path: 'index.html', content: INDEX_HTML },
          ...Array.from({ length: 50 }, (_unused, index) => ({
            path: `file-${index}.js`,
            content: 'x',
          })),
        ]),
      )

      expect(response.status()).toBe(413)
      expect((await errorBody(response)).error.code).toBe('BUNDLE_TOO_LARGE')
    })

    test('a .php file is 422 FILE_TYPE_NOT_ALLOWED', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(
        request,
        bundle([
          { path: 'index.html', content: INDEX_HTML },
          { path: 'shell.php', content: '<?php ?>' },
        ]),
      )

      expect(response.status()).toBe(422)
      expect((await errorBody(response)).error.code).toBe('FILE_TYPE_NOT_ALLOWED')
    })

    test('no index.html is 422 ENTRY_MISSING', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(request, bundle([{ path: 'app.js', content: 'x' }]))

      expect(response.status()).toBe(422)
      expect((await errorBody(response)).error.code).toBe('ENTRY_MISSING')
    })

    test('duplicate paths are 422 VALIDATION_FAILED', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(
        request,
        bundle([
          { path: 'index.html', content: INDEX_HTML },
          { path: 'app.js', content: 'first' },
          { path: 'app.js', content: 'second' },
        ]),
      )

      expect(response.status()).toBe(422)
      expect((await errorBody(response)).error.code).toBe('VALIDATION_FAILED')
    })

    test('a single file over 2 MB is 413 BUNDLE_TOO_LARGE', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(
        request,
        bundle([
          { path: 'index.html', content: INDEX_HTML },
          { path: 'big.js', content: 'a'.repeat(2_097_153) },
        ]),
      )

      expect(response.status()).toBe(413)
      expect((await errorBody(response)).error.code).toBe('BUNDLE_TOO_LARGE')
    })

    test('a total over 10 MB is 413 BUNDLE_TOO_LARGE', async ({ request }) => {
      await signIn(request)
      const response = await postBundle(
        request,
        bundle([
          { path: 'index.html', content: INDEX_HTML },
          ...Array.from({ length: 6 }, (_unused, index) => ({
            path: `chunk-${index}.js`,
            content: 'a'.repeat(2_000_000),
          })),
        ]),
      )

      expect(response.status()).toBe(413)
      expect((await errorBody(response)).error.code).toBe('BUNDLE_TOO_LARGE')
    })

    test('a form-encoded post is refused, which is the CSRF shape', async ({ request }) => {
      await signIn(request)
      const response = await request.post('/api/v1/artifacts', {
        form: { title: 'x' },
        maxRedirects: 0,
      })

      expect(response.status()).toBe(422)
      expect((await errorBody(response)).error.code).toBe('VALIDATION_FAILED')
    })
  })

  test('rejects a limit above the maximum', async ({ request }) => {
    await signIn(request)
    const response = await request.get('/api/v1/artifacts?limit=101')

    expect(response.status()).toBe(422)
    expect((await errorBody(response)).error.code).toBe('VALIDATION_FAILED')
  })

  test('lists the created artifact and pages with the cursor', async ({ request }) => {
    await signIn(request)
    await postBundle(request, { ...bundle([{ path: 'index.html', content: INDEX_HTML }]) })

    const firstPage = (await (await request.get('/api/v1/artifacts?limit=1')).json()) as ListEnvelope
    expect(firstPage.data.items).toHaveLength(1)
    expect(firstPage.data.nextCursor).not.toBeNull()

    const nextPage = (await (
      await request.get(`/api/v1/artifacts?limit=1&cursor=${firstPage.data.nextCursor ?? ''}`)
    ).json()) as ListEnvelope
    expect(nextPage.data.items[0]?.id).not.toBe(firstPage.data.items[0]?.id)
  })

  test('the dashboard renders the artifact list instead of the empty state', async ({ page }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill(ADMIN_EMAIL)
    await page.getByLabel('Password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/dashboard$/)

    await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sales dash' }).first()).toBeVisible()
    await expect(page.getByText('Only me').first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No artifacts yet' })).toBeHidden()
  })
})
