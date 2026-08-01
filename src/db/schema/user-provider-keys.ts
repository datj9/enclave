import { customType, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { PROVIDER_IDS } from '@/lib/providers/types'
import { users } from './users'

/**
 * grill-result §5.2. A user's own provider key, sealed with `ENCRYPTION_KEY` before it ever
 * reaches Postgres (§8, A.10.1.1). Only `src/lib/crypto/envelope.ts` can open it, and the
 * plaintext is never returned to a client — see `app/api/v1/settings/keys/route.ts`.
 */

/** Postgres `bytea`. Local to this file so the shared column-types module stays untouched. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const userProviderKeys = pgTable(
  'user_provider_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    provider: text('provider', { enum: PROVIDER_IDS }).notNull(),
    encryptedKey: bytea('encrypted_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
)

export type UserProviderKey = typeof userProviderKeys.$inferSelect
export type NewUserProviderKey = typeof userProviderKeys.$inferInsert
