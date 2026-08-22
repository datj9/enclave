import { customType, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'

import { users } from './users'

/**
 * One-time password reset, mirroring the invite token contract: only `sha256(token)` is ever
 * stored; the plaintext is sent once in the reset mail and is unrecoverable afterwards.
 *
 * `used_at` means "consumed by a successful reset" only. Outstanding rows for a user are
 * deleted when a new request replaces them, so they never accumulate as audit history.
 */

/** Postgres `bytea`. Local to this file so the shared column-types module stays untouched. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: bytea('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The cleanup order when a new request replaces outstanding rows: newest first.
    index('password_reset_tokens_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
)

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert
