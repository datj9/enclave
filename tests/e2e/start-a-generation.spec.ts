import { expect, test, type APIRequestContext } from '@playwright/test'
import postgres from 'postgres'

import { hashPassword } from '../../src/lib/auth/password'

/**
 * `/new` is fully built but nothing linked to it until this dashboard change, so a signed-in user
 * could only reach the composer by typing the URL.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on an
 * empty database — a spec that consumes the single-use setup before it runs breaks it. This one
 * never touches `/setup`: it seeds its own member the way `two-account-privacy.spec.ts` does, and
 * that account owns no artifacts in any run order, which is what makes the empty state assertable.
 */

const MEMBER_EMAIL = 'generation-entry@example.com'
const MEMBER_PASSWORD = 'entry-point-passphrase'

function databaseClient() {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL is not set')
  return postgres(databaseUrl, { max: 1 })
}

/** No password self-registration exists yet, so the account is seeded directly. */
async function createMemberAccount(): Promise<void> {
  const sql = databaseClient()
  try {
    const passwordHash = await hashPassword(MEMBER_PASSWORD)
    await sql`
      insert into users (email, password_hash, role, is_active)
      values (${MEMBER_EMAIL}, ${passwordHash}, 'member', true)
      on conflict (email) do update set password_hash = excluded.password_hash, is_active = true
    `
  } finally {
    await sql.end()
  }
}

async function signInAsMember(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/auth/signin', {
    headers: { 'content-type': 'application/json' },
    data: { email: MEMBER_EMAIL, password: MEMBER_PASSWORD },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

test.describe('the dashboard links to the prompt composer', () => {
  test.beforeAll(createMemberAccount)

  // Both entry points in one test on one context: the per-IP auth limit is 30 an hour for the
  // whole suite (RATE_LIMIT_AUTH_PER_IP_PER_HOUR), and a second test would spend a second sign-in
  // on the same assertion path.
  test('both dashboard entry points reach the composer', async ({ page, context }) => {
    await signInAsMember(context.request)

    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: 'No artifacts yet' })).toBeVisible()
    await page.getByRole('link', { name: 'Describe your first artifact' }).click()
    await expect(page).toHaveURL(/\/new$/)
    await expect(page.getByLabel('Describe the artifact')).toBeVisible()

    await page.goto('/dashboard')
    await page.getByRole('link', { name: 'New artifact' }).click()
    await expect(page).toHaveURL(/\/new$/)
    await expect(page.getByLabel('Describe the artifact')).toBeVisible()
  })
})
