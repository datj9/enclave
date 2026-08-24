/**
 * Cron entry point for password-reset retention. Run with tsx, which resolves the `@/*` path alias
 * the job's imports use:
 *
 *   pnpm exec tsx scripts/prune-password-resets.ts
 *
 * Add that as the crontab line (or the command of a scheduled container) once a day, alongside
 * scripts/prune-audit.ts.
 */
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const { prunePasswordResetTokens } = await import('../src/jobs/prune-password-resets.ts')

const result = await prunePasswordResetTokens()
console.info(
  `[enclave] pruned ${result.prunedRowCount} spent password reset row(s) older than ${result.retentionDays} day(s)`,
)
process.exit(0)
