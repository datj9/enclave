/**
 * Cron entry point for the trash purge. Run with tsx, which resolves the `@/*` path alias the
 * job's imports use:
 *
 *   pnpm exec tsx scripts/purge-trash.ts
 *
 * Add that as the crontab line (or the command of a scheduled container) once a day, alongside
 * scripts/prune-audit.ts.
 */
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const { purgeTrashedArtifacts } = await import('../src/jobs/purge-trash.ts')

const result = await purgeTrashedArtifacts()
console.info(
  `[enclave] purged ${result.purgedArtifactCount} artifact(s) past ${result.retentionDays} day(s), ` +
    `${result.failedArtifactCount} deferred to the next run`,
)
process.exit(result.failedArtifactCount === 0 ? 0 : 1)
