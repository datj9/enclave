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
  },
})
