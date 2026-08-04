import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Deadlines must render in the VIEWER'S zone with a zone label, not the server host's zone.
 *
 * Asserting the absence of a React hydration warning does NOT work here and was tried: the harness
 * runs a production build (`pnpm start`), and production React recovers from a text mismatch
 * silently — a console-only check passes against the pre-fix `toLocale*` calls and proves nothing.
 * What is observable in production is the rendered text itself, so that is what this asserts.
 *
 * The zone label is the discriminator: `src/lib/format/instant.ts` always formats with
 * `timeZoneName: 'short'`, while every call site it replaced used a bare `toLocaleString()` /
 * `toLocaleDateString()` that emitted none. A label in the viewer's zone therefore cannot be
 * produced by the old code, and — because production React keeps the SERVER's text on a mismatch —
 * cannot be produced by a server render either.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

/**
 * Load-bearing, not cosmetic: the server renders in the host's zone and the browser in this one, so
 * they must differ or a host-zone string would match the viewer's by accident. New York is west of
 * every plausible host zone a CI runner or developer machine uses, so the calendar day differs too.
 */
test.use({ timezoneId: 'America/New_York' })

/**
 * What `timeZoneName: 'short'` produces for America/New_York — `GMT-4` in EDT, `GMT-5` in EST.
 * Not `EDT`: `src/lib/format/instant.ts` formats with the `en-GB` locale, which renders US zones as
 * a GMT offset rather than a letter abbreviation.
 *
 * This offset is the whole assertion. The host renders in Asia/Saigon (GMT+7) and emits no label at
 * all before the fix, so a west-of-UTC offset here can only come from the viewer's own zone after
 * hydration — which is exactly the contract.
 */
const NEW_YORK_ZONE_LABEL = /GMT-[45]\b/

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

test('a deadline renders in the viewer zone with a zone label', async ({ page, context }) => {
  await signInAsAdmin(context.request)

  const created = await context.request.post('/api/v1/invites', {
    headers: { 'content-type': 'application/json' },
    data: { email: 'hydration-probe@example.test', expiresInHours: 48 },
  })
  expect(created.status()).toBe(201)

  await page.goto('/admin/invites')
  // The local string only exists after the first client commit, so wait for it rather than for
  // the network — a server-rendered page is already idle before hydration has run.
  await expect(page.getByText(NEW_YORK_ZONE_LABEL).first()).toBeVisible()

  const rendered = await page.getByText(NEW_YORK_ZONE_LABEL).first().innerText()
  expect(rendered).toMatch(NEW_YORK_ZONE_LABEL)
})
