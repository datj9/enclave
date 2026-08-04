import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * `/new` is fully built but nothing links to it until this dashboard change — see
 * `.devkit/spec-generation-batch1.md` § T1. Both entry points are exercised in one file
 * since the freshly-created admin owns zero artifacts, so the dashboard renders the empty
 * state (and its CTA) rather than an artifact list.
 *
 * The file name sorts before `setup-and-signin.spec.ts`, so it cannot assume the seeded admin
 * already exists — `signInAsAdmin` below creates it if `/setup` is still open.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

async function signInAsAdmin(request: APIRequestContext): Promise<void> {
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

test.describe('the dashboard links to /new (T1 reachability)', () => {
  test('the header New artifact link reaches the composer', async ({ page, context }) => {
    await signInAsAdmin(context.request)
    await page.goto('/dashboard')

    await page.getByRole('link', { name: 'New artifact' }).click()

    await expect(page).toHaveURL(/\/new$/)
    await expect(page.getByLabel('Describe the artifact')).toBeVisible()
  })

  test('the empty-state CTA reaches the composer too', async ({ page, context }) => {
    await signInAsAdmin(context.request)
    await page.goto('/dashboard')

    // Only true while the seeded admin owns zero artifacts — this file runs before any spec
    // that creates one, see the header comment.
    await expect(page.getByRole('heading', { name: 'No artifacts yet' })).toBeVisible()

    await page.getByRole('link', { name: 'Describe your first artifact' }).click()

    await expect(page).toHaveURL(/\/new$/)
    await expect(page.getByLabel('Describe the artifact')).toBeVisible()
  })
})
