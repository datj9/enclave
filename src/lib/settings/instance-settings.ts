import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { instanceSettings } from '@/db/schema/instance-settings'
import { recordAuditEvent } from '@/lib/audit'

export const AUTO_CATEGORIZE_KEY = 'auto_categorize_enabled'

export async function getAutoCategorizeEnabled(): Promise<boolean> {
  const [row] = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, AUTO_CATEGORIZE_KEY))
    .limit(1)

  return row !== undefined && typeof row.value === 'boolean' ? row.value : false
}

export async function setAutoCategorizeEnabled(enabled: boolean, updatedBy: string): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: AUTO_CATEGORIZE_KEY, value: enabled, updatedBy })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: enabled, updatedBy, updatedAt: new Date() },
    })

  await recordAuditEvent({
    action: 'settings.update',
    actorUserId: updatedBy,
    metadata: { key: AUTO_CATEGORIZE_KEY, value: enabled },
  })
}
