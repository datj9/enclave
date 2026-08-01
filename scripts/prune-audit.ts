/**
 * Cron entry point for audit-log retention. Run with tsx, which resolves the `@/*` path alias
 * the job's imports use:
 *
 *   pnpm exec tsx scripts/prune-audit.ts
 *
 * Add that as the crontab line (or the command of a scheduled container) once a day.
 */
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const { pruneAuditLog } = await import('../src/jobs/prune-audit.ts')

const result = await pruneAuditLog()
console.info(
  `[enclave] pruned ${result.prunedRowCount} audit row(s) older than ${result.retentionDays} day(s)`,
)
process.exit(0)
