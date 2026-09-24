import { config as loadDotenv } from 'dotenv'
import { defineConfig, devices } from '@playwright/test'

loadDotenv()

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const isCi = process.env.CI === 'true' || process.env.CI === '1'

/**
 * Every spec shares one database, so run order is part of the contract. It used to be encoded in
 * file names (a `zz-` prefix sorted a file last); it is now the project graph below, which
 * Playwright enforces and a rename cannot silently break:
 *
 *  1. `first-run` — setup-and-signin.spec.ts asserts `/setup` is still open on the empty database
 *     global-setup.ts leaves behind, then creates the administrator. It must run before anything
 *     else, because every other spec that signs in as the admin creates it on demand.
 *  2. `chromium` — everything not listed elsewhere, once the administrator exists.
 *  3. `chromium-late` — specs that seed extra admin-owned artifacts. They run after `chromium`
 *     because upload-and-list.spec.ts asserts a row on the dashboard's first page, and
 *     dashboard-pagination.spec.ts alone seeds enough artifacts to push it onto the second.
 *
 * A project whose dependency failed does not run (Playwright reports it as skipped/"did not run"),
 * so a broken first-run surfaces as one failure rather than twenty confusing ones.
 *
 * File and `-g` filters do not apply to dependency projects: `playwright test dashboard-pagination`
 * runs all of `first-run` and `chromium` first. Add `--no-deps` to run just the named spec (most
 * create the administrator on demand if it does not exist yet).
 */
const FIRST_RUN_SPECS = [/[\\/]setup-and-signin\.spec\.ts$/]
const LATE_SPECS = [
  /[\\/]artifact-download\.spec\.ts$/,
  /[\\/]dashboard-pagination\.spec\.ts$/,
  /[\\/]design-system\.spec\.ts$/,
  /[\\/]direct-artifact-entry\.spec\.ts$/,
  /[\\/]hydration-console\.spec\.ts$/,
]

export default defineConfig({
  testDir: './tests/e2e',
  // The setup flow is single-use per database, so specs cannot share one.
  workers: 1,
  fullyParallel: false,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'first-run',
      testMatch: FIRST_RUN_SPECS,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: [...FIRST_RUN_SPECS, ...LATE_SPECS],
      dependencies: ['first-run'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium-late',
      testMatch: LATE_SPECS,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm start',
    url: `${baseURL}/healthz`,
    reuseExistingServer: true,
    timeout: 120_000,
    // The whole suite signs in from one IP, so it shares the single per-IP hourly auth bucket the
    // app enforces (`RATE_LIMIT_AUTH_PER_IP_PER_HOUR`, 30 by default) — and CI retries spend from it
    // twice. Under the shipped default every new spec that signs in 429s some unrelated spec, so the
    // harness raises it here. No e2e test asserts the auth 429; tests/unit/rate-limit.test.ts covers
    // the limiter itself against the real default. Ignored when `reuseExistingServer` picks up a
    // server someone already started.
    env: { RATE_LIMIT_AUTH_PER_IP_PER_HOUR: '500' },
  },
})
