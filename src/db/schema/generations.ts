import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { PROVIDER_IDS } from '@/lib/providers/types'
import { users } from './users'

export const GENERATION_STATUSES = ['streaming', 'succeeded', 'failed'] as const
export type GenerationStatus = (typeof GENERATION_STATUSES)[number]

/**
 * grill-result §5.2. One row per generation attempt, written before the first provider call and
 * finished exactly once — the row is the only durable record that an attempt happened, which is
 * what S7 counts for its daily quota.
 *
 * `prompt` lives here and nowhere else: §8 forbids prompt text in logs and in `audit_log`.
 */
export const generations = pgTable(
  'generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // §5.2 declares this column without a foreign key, and it stays that way: a failed generation
    // records the artifact it was going to become only when one was created.
    artifactId: uuid('artifact_id'),
    provider: text('provider', { enum: PROVIDER_IDS }).notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    status: text('status', { enum: GENERATION_STATUSES }).notNull(),
    errorCode: text('error_code'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    usedInstanceKey: boolean('used_instance_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'generations_status_check',
      sql`${table.status} in ('streaming', 'succeeded', 'failed')`,
    ),
    // S7 counts a user's generations inside a rolling window; this is that query's index.
    index('generations_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
)

export type Generation = typeof generations.$inferSelect
export type NewGeneration = typeof generations.$inferInsert
