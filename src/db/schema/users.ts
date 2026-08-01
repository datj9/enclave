import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

import { citext } from './column-types'

export const USER_ROLES = ['admin', 'member'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** grill-result §5.2. Later slices add their own tables; none of them alter this one. */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull().unique(),
    passwordHash: text('password_hash'),
    oidcSub: text('oidc_sub').unique(),
    role: text('role', { enum: USER_ROLES }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [
    // `text({enum})` is compile-time only; §5.2 asks for the constraint in the database too.
    check('users_role_check', sql`${table.role} in ('admin', 'member')`),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
