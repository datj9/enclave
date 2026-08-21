import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { users } from './users'

/**
 * Per-instance configuration persisted as a key/value pair. `value` is a jsonb so a setting can
 * be a boolean today and a richer object later without a migration.
 */
export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type InstanceSetting = typeof instanceSettings.$inferSelect
export type NewInstanceSetting = typeof instanceSettings.$inferInsert
