import { lt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { AUDIT_PRUNE_SETTING } from '@/db/audit-log-guard'
import { auditLog } from '@/db/schema/audit-log'
import { env } from '@/env'

/**
 * Retention for the audit trail (§5.2): rows older than `AUDIT_RETENTION_DAYS` are dropped.
 * `actor_ip` makes these rows PII, so keeping them forever is not the safe default it looks like.
 *
 * This is the one code path allowed to delete from `audit_log`. The append-only trigger refuses
 * every other DELETE, and it recognises this one solely by the transaction-local setting below —
 * which is why the delete has to stay inside the transaction that sets it.
 *
 * Run it on the same schedule as the purge job:
 *   0 3 * * * cd /app && pnpm exec tsx scripts/prune-audit.ts
 */

export interface PruneAuditResult {
  readonly prunedRowCount: number
  readonly retentionDays: number
}

export async function pruneAuditLog(
  retentionDays: number = env.AUDIT_RETENTION_DAYS,
): Promise<PruneAuditResult> {
  const pruned = await db.transaction(async (transaction) => {
    // `set_config(..., is_local => true)` is `SET LOCAL`: it reverts when this transaction ends,
    // so no later statement on the pooled connection inherits permission to delete.
    await transaction.execute(sql`select set_config(${AUDIT_PRUNE_SETTING}, 'on', true)`)

    return transaction
      .delete(auditLog)
      // Postgres `now()`, never app-server time (§7 clock skew).
      .where(lt(auditLog.at, sql`now() - make_interval(days => ${retentionDays})`))
      .returning({ id: auditLog.id })
  })

  return { prunedRowCount: pruned.length, retentionDays }
}
