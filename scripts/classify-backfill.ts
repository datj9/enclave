/**
 * One-shot entry point that classifies artifacts created before auto-categorize was enabled.
 * Run with tsx, which resolves the `@/*` path alias the job's imports use:
 *
 *   pnpm exec tsx scripts/classify-backfill.ts [--limit <n>] [--owner <userId>] [--dry-run]
 *
 * Re-running is safe but not free: every eligible artifact costs another provider call, so size
 * the first pass with --limit and preview it with --dry-run. Already-tagged and manually-tagged
 * artifacts are skipped. The live classifier gates (setting off, no instance key, empty taxonomy)
 * still apply. Exits non-zero when any eligible artifact ended the run untagged.
 */
import { parseArgs } from 'node:util'

import { config as loadDotenv } from 'dotenv'

loadDotenv()

const { values } = parseArgs({
  options: {
    limit: { type: 'string' },
    owner: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
})

const limit = values.limit === undefined ? undefined : Number(values.limit)
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error(`[enclave] --limit must be a positive integer, got "${values.limit}"`)
  process.exit(2)
}

const { backfillArtifactCategories } = await import('../src/jobs/classify-backfill.ts')

const result = await backfillArtifactCategories(undefined, {
  ownerId: values.owner,
  limit,
  isDryRun: values['dry-run'],
})

if (values['dry-run'] === true) {
  console.info(`[enclave] backfill dry run: ${result.eligibleCount} artifact(s) would be classified`)
  process.exit(0)
}

console.info(
  `[enclave] backfill tagged ${result.classifiedCount} artifact(s), ` +
    `${result.skippedCount} left untagged, ${result.eligibleCount} eligible`,
)
process.exit(result.skippedCount === 0 ? 0 : 1)
