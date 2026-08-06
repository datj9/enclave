import { config as loadDotenv } from 'dotenv'
import { defineConfig, devices } from '@playwright/test'

loadDotenv()

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const isCi = process.env.CI === 'true' || process.env.CI === '1'

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
