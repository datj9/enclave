import { and, isNotNull, lt, lte, or, sql } from 'drizzle-orm'

import { db } from '@/db'
import { passwordResetTokens } from '@/db/schema/password-reset-tokens'
import { env } from '@/env'

/**
 * Retention for spent reset rows (§8 data retention). Neither request path deletes them: both
 * clear `used_at is null` only, so a consumed row is permanent and an expired unused row waits for
 * that user's next request. `audit_log` is the reset history; these rows are only the capability.
 *
 * The window is measured on `created_at`, the one column every row has: a used row was used before
 * it expired, so nothing consumed inside the window can be older than it on that column.
 *
 * Run it on the same schedule as the audit prune:
 *   0 3 * * * cd /app && pnpm exec tsx scripts/prune-password-resets.ts
 */

export interface PrunePasswordResetsResult {
  readonly prunedRowCount: number
  readonly retentionDays: number
}

export async function prunePasswordResetTokens(
  retentionDays: number = env.PASSWORD_RESET_RETENTION_DAYS,
): Promise<PrunePasswordResetsResult> {
  const pruned = await db
    .delete(passwordResetTokens)
    .where(
      and(
        or(isNotNull(passwordResetTokens.usedAt), lte(passwordResetTokens.expiresAt, sql`now()`)),
        // Postgres `now()`, never app-server time (§7 clock skew). `hours`, not `days`: `days` is
        // a calendar field on a timestamptz and drifts across a DST transition (TASK-6).
        lt(
          passwordResetTokens.createdAt,
          sql`now() - make_interval(hours => ${retentionDays * 24})`,
        ),
      ),
    )
    .returning({ id: passwordResetTokens.id })

  return { prunedRowCount: pruned.length, retentionDays }
}
