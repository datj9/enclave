import { date, integer, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core'

import { users } from './users'

/**
 * grill-result §5.2. One row per user per UTC day, incremented once for every generation that
 * actually reached the provider — the daily half of §5.7's quota pair.
 *
 * The hourly limit is not stored here: it counts `generations` rows in a rolling window, which
 * a fixed-window counter cannot express. See `src/lib/quota.ts`.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    windowDate: date('window_date').notNull(),
    generations: integer('generations').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.windowDate] })],
)

export type UsageCounter = typeof usageCounters.$inferSelect
export type NewUsageCounter = typeof usageCounters.$inferInsert
