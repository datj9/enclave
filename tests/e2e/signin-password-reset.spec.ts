import { expect, test } from '@playwright/test'

/**
 * Thin password-reset UX coverage that runs without real SMTP (missing `SMTP_HOST` still boots,
 * and forgot-password still returns the generic success). The filename sorts after
 * `setup-and-signin.spec.ts`, so the first-run administrator already exists. A successful consume
 * is deliberately not driven here — the full token lifecycle is covered in
 * `tests/integration/password-reset.test.ts` against real Postgres.
 */
test.describe.configure({ mode: 'serial' })

test.describe('password reset form ux', () => {
  test('sign-in offers a Forgot password? link under the submit button', async ({ page }) => {
    await page.goto('/signin')

    const forgotPasswordLink = page.getByRole('link', { name: 'Forgot password?' })
    await expect(forgotPasswordLink).toBeVisible()
    await expect(forgotPasswordLink).toHaveAttribute('href', '/forgot-password')
  })

  test('forgot-password submits to the generic success state without SMTP', async ({ page }) => {
    await page.goto('/forgot-password')

    await expect(page.getByLabel('Password')).toHaveCount(0)

    await page.getByLabel('Email').fill('ops@example.com')
    await page.getByRole('button', { name: 'Send reset link' }).click()

    await expect(page).toHaveURL(/\/forgot-password\?sent=1$/)
    await expect(page.getByRole('status')).toHaveText(
      'If that email is on this instance, we sent a reset link.',
    )
  })

  test('forgot-password shows the same success for an unknown email', async ({ page }) => {
    await page.goto('/forgot-password')

    await page.getByLabel('Email').fill('nobody-reset@example.com')
    await page.getByRole('button', { name: 'Send reset link' }).click()

    await expect(page).toHaveURL(/\/forgot-password\?sent=1$/)
    await expect(page.getByRole('status')).toHaveText(
      'If that email is on this instance, we sent a reset link.',
    )
  })

  test('reset-password renders a password form without email and rejects a junk token generically', async ({
    page,
  }) => {
    await page.goto('/reset-password?t=pwr_thisisnotavalidtokenvalue')

    await expect(page.getByLabel('Email')).toHaveCount(0)

    await page.getByLabel('Password').fill('new-correct-horse')
    await page.getByRole('button', { name: 'Reset password' }).click()

    await expect(page).toHaveURL(/\/reset-password\?.*error=invalid/)
    // Scoped to the form: Next.js renders its own route announcer with role="alert".
    await expect(page.locator('form [role="alert"]')).toHaveText(
      'This reset link is invalid or has expired.',
    )
  })

  test('robots.txt disallows the reset capability URLs', async ({ request }) => {
    const robots = await (await request.get('/robots.txt')).text()

    expect(robots).toContain('Disallow: /forgot-password')
    expect(robots).toContain('Disallow: /reset-password')
  })
})
