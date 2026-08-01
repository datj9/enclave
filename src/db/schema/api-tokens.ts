import { customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { users } from './users'

/**
 * grill-result §5.2. Only `sha256(token)` is ever stored — the plaintext is returned once by
 * `POST /api/v1/tokens` and is unrecoverable afterwards (§8, A.10.1.1).
 */

/** Postgres `bytea`. Local to this file so the shared column-types module stays untouched. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

/**
 * `shares:write` is accepted now although share links only arrive in S5: a token minted today
 * must keep working when that route lands, and widening the set later would force a re-mint.
 */
export const API_TOKEN_SCOPES = ['artifacts:read', 'artifacts:write', 'shares:write'] as const
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number]

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    tokenHash: bytea('token_hash').notNull().unique(),
    scopes: text('scopes', { enum: API_TOKEN_SCOPES }).array().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Matches the settings list order: one user's tokens, newest first.
    index('api_tokens_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
)

export type ApiToken = typeof apiTokens.$inferSelect
export type NewApiToken = typeof apiTokens.$inferInsert
