import { customType, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'

import { citext } from './column-types'
import { users } from './users'

/**
 * grill-result §5.2. Only `sha256(token)` is ever stored — the plaintext is returned once by
 * `POST /api/v1/invites` and is unrecoverable afterwards (§8, A.10.1.1), the same contract
 * `api_tokens` holds.
 *
 * `revoked_at` and `created_at` are additions to the §5.2 sketch: the S10 acceptance criteria
 * require revoking an outstanding invite, and revoking by deleting the row would erase who issued
 * it, which A.12.4.1 needs to stay reconstructable alongside the `user.invite` audit row.
 */

/** Postgres `bytea`. Local to this file so the shared column-types module stays untouched. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null means "anyone holding the link". A named invite is bound to that address at redemption.
    email: citext('email'),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The admin list order: newest first.
    index('invites_created_at_idx').on(table.createdAt.desc()),
    // The OIDC seam's only lookup: an outstanding invite for an asserted email.
    index('invites_email_idx').on(table.email),
  ],
)

export type Invite = typeof invites.$inferSelect
export type NewInvite = typeof invites.$inferInsert
