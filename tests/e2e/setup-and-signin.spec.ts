import { expect, test, type APIResponse, type Page } from '@playwright/test'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

async function submitCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in|create administrator/i }).click()
}

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string }
}

async function errorBody(response: APIResponse): Promise<ErrorEnvelope> {
  return (await response.json()) as ErrorEnvelope
}

/**
 * One spec file, run serially: it walks the whole first-run path in order, because each step
 * changes the instance's state in a way the next step depends on.
 */
test.describe.configure({ mode: 'serial' })

test.describe('first run: setup then sign in', () => {
  test('healthz reports the database is reachable', async ({ request }) => {
    const response = await request.get('/healthz')

    expect(response.status()).toBe(200)
    expect(await response.json()).toEqual({ data: { status: 'ok', database: 'ok' } })
  })

  test('setup is reachable while no user exists', async ({ page }) => {
    const response = await page.goto('/setup')

    expect(response?.status()).toBe(200)
    await expect(page.getByRole('heading', { name: 'Create the administrator' })).toBeVisible()
  })

  test('setup rejects a weak password without creating anything', async ({ request }) => {
    const response = await request.post('/api/setup', {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: 'short' },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(422)
    expect((await errorBody(response)).error.code).toBe('VALIDATION_FAILED')

    // Still reachable, so nothing was written.
    expect((await request.get('/setup')).status()).toBe(200)
  })

  test('two concurrent submits produce exactly one admin and one 409', async ({ request }) => {
    const submit = () =>
      request.post('/api/setup', {
        headers: { 'content-type': 'application/json' },
        data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        maxRedirects: 0,
      })

    const [first, second] = await Promise.all([submit(), submit()])
    const statuses = [first.status(), second.status()].sort((left, right) => left - right)

    expect(statuses).toEqual([303, 409])

    const conflicted = first.status() === 409 ? first : second
    const conflictBody = await errorBody(conflicted)
    expect(conflictBody.error.code).toBe('VALIDATION_FAILED')
    expect(conflictBody.error.message).toBe('Setup has already been completed')

    const created = first.status() === 303 ? first : second
    expect(created.headers()['location']).toBe('/dashboard')
  })

  test('the session cookie is HttpOnly, Secure, SameSite=Lax and has no Domain', async ({
    request,
  }) => {
    // Re-reading the created admin's cookie is impossible, so sign in again to inspect it.
    const response = await request.post('/api/auth/signin', {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(303)
    const setCookie = response.headers()['set-cookie'] ?? ''

    expect(setCookie).toContain('enclave_session=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Path=/')
    // Load-bearing: a Domain attribute would make the session readable by every artifact
    // origin under the same parent domain (grill-result §4.1, §8).
    expect(setCookie).not.toMatch(/;\s*Domain=/i)
  })

  test('setup 404s once a user exists', async ({ request }) => {
    expect((await request.get('/setup')).status()).toBe(404)
  })

  test('signing in with the wrong password gives a generic failure', async ({ request }) => {
    const response = await request.post('/api/auth/signin', {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: 'wrong-horse-battery' },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
    const body = await errorBody(response)
    expect(body.error.code).toBe('UNAUTHENTICATED')
    expect(body.error.message).toBe('Email or password is incorrect')
  })

  test('an unknown email fails identically to a wrong password', async ({ request }) => {
    const response = await request.post('/api/auth/signin', {
      headers: { 'content-type': 'application/json' },
      data: { email: 'nobody@example.com', password: ADMIN_PASSWORD },
      maxRedirects: 0,
    })

    expect(response.status()).toBe(401)
    expect((await errorBody(response)).error.message).toBe('Email or password is incorrect')
  })

  test('the dashboard redirects to sign-in without a session', async ({ page }) => {
    await page.goto('/dashboard')

    await expect(page).toHaveURL(/\/signin$/)
  })

  test('signing in through the form lands on the dashboard', async ({ page, context }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, ADMIN_PASSWORD)

    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'No artifacts yet' })).toBeVisible()
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible()

    const sessionCookie = (await context.cookies()).find(
      (cookie) => cookie.name === 'enclave_session',
    )
    expect(sessionCookie?.httpOnly).toBe(true)
    expect(sessionCookie?.secure).toBe(true)
    expect(sessionCookie?.sameSite).toBe('Lax')
    // Playwright reports a host-only cookie's domain without a leading dot.
    expect(sessionCookie?.domain).toBe('localhost')
  })

  test('settings is reachable from the dashboard and its sections link to each other', async ({
    page,
  }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings\/keys$/)
    await expect(page.getByRole('heading', { name: 'Provider key' })).toBeVisible()

    const sections = page.getByRole('navigation', { name: 'Settings sections' })
    await expect(sections.getByRole('link', { name: 'Provider key' })).toHaveAttribute(
      'aria-current',
      'page',
    )

    await sections.getByRole('link', { name: 'API tokens' }).click()
    await expect(page).toHaveURL(/\/settings\/tokens$/)
    await expect(page.getByRole('heading', { name: 'API tokens' })).toBeVisible()

    await page.getByRole('link', { name: 'Back to artifacts' }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
  })

  test('a bad form sign-in returns to the form with a generic message', async ({ page }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, 'wrong-horse-battery')

    await expect(page).toHaveURL(/\/signin\?error=invalid$/)
    // Scoped to the form: Next.js renders its own route announcer with role="alert".
    await expect(page.locator('form [role="alert"]')).toHaveText('Email or password is incorrect.')
  })

  test('signing out clears the session', async ({ page }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/signin$/)

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/signin$/)
  })
})
