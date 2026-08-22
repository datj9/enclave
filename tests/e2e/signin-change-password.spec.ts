import { expect, test, type Page } from '@playwright/test'

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

async function submitCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in|create administrator/i }).click()
}

/**
 * Thin change-password UX coverage that runs after the first-run administrator exists. A
 * successful password change is deliberately not driven here — that would rotate the shared
 * `ops@example.com` account and break later specs. The full lifecycle is covered in
 * `tests/integration/change-password.test.ts` against real Postgres.
 */
test.describe.configure({ mode: 'serial' })

test.describe('settings change password', () => {
  test('settings nav includes a Password link when signed in', async ({ page }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.goto('/settings/keys')

    const passwordLink = page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Password' })
    await expect(passwordLink).toBeVisible()
    await expect(passwordLink).toHaveAttribute('href', '/settings/password')
  })

  test('settings password page renders the change-password form after sign-in', async ({
    page,
  }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.goto('/settings/password')

    await expect(page.getByRole('heading', { name: 'Password' })).toBeVisible()
    await expect(page.getByLabel('Current password')).toBeVisible()
    await expect(page.getByLabel('New password')).toBeVisible()
    await expect(page.getByLabel('Confirm new password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Update password' })).toBeVisible()
  })

  test('wrong current password shows an alert and leaves the user signed in', async ({ page }) => {
    await page.goto('/signin')
    await submitCredentials(page, ADMIN_EMAIL, ADMIN_PASSWORD)
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.goto('/settings/password')

    await page.getByLabel('Current password').fill('wrong-horse-battery')
    await page.getByLabel('New password').fill('new-correct-horse')
    await page.getByLabel('Confirm new password').fill('new-correct-horse')
    await page.getByRole('button', { name: 'Update password' }).click()

    await expect(page).toHaveURL(/\/settings\/password\?error=wrong_current$/)
    await expect(page.locator('form [role="alert"]')).toHaveText('Current password is incorrect.')
    await expect(page.getByRole('heading', { name: 'Password' })).toBeVisible()
  })
})
