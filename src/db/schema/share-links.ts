import { customType, index, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'

import { artifactVersions, artifacts } from './artifacts'
import { users } from './users'

/**
 * grill-result §5.2. A share link is the third privacy level of §5.1 — "anyone with the link" is
 * derived from an active row here rather than being a fourth `visibility` value.
 *
 * Only `sha256(token)` is ever stored. The plaintext is returned once by
 * `POST /api/v1/artifacts/{id}/shares` and is unrecoverable afterwards (§8, A.10.1.1).
 */

/** Postgres `bytea`. Local to this file so the shared column-types module stays untouched. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /**
     * The pinned version (§5.1 branch 4): the link keeps serving this one after newer versions
     * exist. Cascading is what turns S9's purge into the §7 "no longer available" 404 — the link
     * row goes with the bytes rather than outliving them as a dangling reference.
     */
    versionId: uuid('version_id')
      .notNull()
      .references(() => artifactVersions.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Matches `GET /api/v1/artifacts/{id}/shares`: one artifact's links, newest first.
    index('share_links_artifact_created_idx').on(table.artifactId, table.createdAt.desc()),
  ],
)

export type ShareLink = typeof shareLinks.$inferSelect
export type NewShareLink = typeof shareLinks.$inferInsert
