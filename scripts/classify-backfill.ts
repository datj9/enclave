/**
 * One-shot entry point that classifies artifacts created before auto-categorize was enabled.
 * Run with tsx, which resolves the `@/*` path alias the job's imports use:
 *
 *   pnpm exec tsx scripts/classify-backfill.ts
 *
 * Safe to re-run: already-tagged and manually-tagged artifacts are skipped. The live classifier
 * gates (setting off, no instance key, empty taxonomy) still apply.
 */
import { config as loadDotenv } from 'dotenv'

loadDotenv()

const { backfillArtifactCategories } = await import('../src/jobs/classify-backfill.ts')

const result = await backfillArtifactCategories()
console.info(
  `[enclave] backfill classified ${result.classifiedCount} artifact(s), ` +
    `skipped ${result.skippedCount}, ${result.eligibleCount} eligible`,
)
process.exit(0)
