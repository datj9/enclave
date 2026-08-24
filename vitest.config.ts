import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@app': fileURLToPath(new URL('./app', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts', 'packages/**/*.test.ts'],
          setupFiles: ['./tests/unit/setup-env.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          // tests/integration/** needs Postgres on 5434 and S3-compatible storage on
          // S3_ENDPOINT. Each of those files skips itself when the service is unreachable, so
          // `vitest run` still passes on a machine with nothing started.
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['./tests/unit/setup-env.ts'],
          // One database, no per-worker isolation: parallel files collide on instance-wide rows
          // (the auto_categorize_enabled setting is a single keyed row that three files toggle).
          // Serial costs ~35s for the whole directory and removes the entire failure class.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // Excluded because they exist only to talk to Postgres or to next/headers, and are
      // exercised end-to-end by the Playwright run instead of with a mock of the whole driver.
      exclude: ['src/db/**', 'src/lib/auth/session.ts', 'src/lib/auth/setup.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
        // S2 acceptance criterion: the bundle validator is held to every branch.
        '**/src/lib/bundle/validate.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // S6 acceptance criterion: the same for the incremental model-output parser.
        '**/src/lib/bundle/parse-file-blocks.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // S4 acceptance criterion: the read gate every read path runs through (§5.1).
        '**/src/lib/artifacts/can-read.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
      },
    },
  },
})
