/**
 * Cron entry point for the stuck-`pending` sweeper. Run with tsx, which resolves the `@/*`
 * path alias the job's imports use:
 *
 *   pnpm exec tsx scripts/sweep-pending.ts
 *
 * Add that as the crontab line (or the command of a scheduled container) once a minute.
 */
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const { sweepPendingVersions } = await import('../src/jobs/sweep-pending.ts')

const result = await sweepPendingVersions()
console.info(
  `[enclave] swept ${result.sweptVersionCount} pending version(s), ` +
    `${result.failedVersionCount} deferred to the next run`,
)
process.exit(result.failedVersionCount === 0 ? 0 : 1)
