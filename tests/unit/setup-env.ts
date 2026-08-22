import { config as loadDotenv } from 'dotenv'

/**
 * A valid environment for modules that read `env` at import time. Tests that exercise
 * validation failures call `parseEnv` with their own record instead of touching this.
 *
 * `.env` is loaded first and wins, because tests/integration/** talks to the real Postgres and
 * object storage a developer (or CI) actually has running. Unit tests are indifferent to the
 * values, so the fallbacks below only matter on a machine with no `.env` at all.
 */
loadDotenv()

const TEST_ENV: Readonly<Record<string, string>> = {
  APP_URL: 'http://localhost:3000',
  ARTIFACT_ORIGIN_TEMPLATE: 'http://{id}.artifacts.localhost:3000',
  DATABASE_URL: 'postgresql://enclave:enclave@localhost:5434/enclave',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'enclave-artifacts',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long',
  ENCRYPTION_KEY: 'test-encryption-key-at-least-32-bytes-long',
  DEFAULT_MODEL: 'claude-sonnet-4-6',
  ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
}

for (const [name, value] of Object.entries(TEST_ENV)) {
  process.env[name] ??= value
}
