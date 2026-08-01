import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import type { ManifestEntry } from '@/lib/bundle/validate'
import { users } from './users'

export const VISIBILITIES = ['private', 'org'] as const
export type Visibility = (typeof VISIBILITIES)[number]

export const VERSION_STATUSES = ['pending', 'ready'] as const
export type VersionStatus = (typeof VERSION_STATUSES)[number]

/** grill-result §5.2. The third privacy level is derived from `share_links` (S5), not an enum value. */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('private'),
    // Circular by design: a version belongs to an artifact, and the artifact points at the one
    // ready version readers get. Stays NULL until the first version flips to `ready` (§5.2, #21).
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => artifactVersions.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    check('artifacts_visibility_check', sql`${table.visibility} in ('private', 'org')`),
    // Matches the list query's keyset order exactly: owner, then created_at desc, id desc.
    index('artifacts_owner_created_idx').on(
      table.ownerId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
)

export const artifactVersions = pgTable(
  'artifact_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    status: text('status', { enum: VERSION_STATUSES }).notNull(),
    entryPath: text('entry_path').notNull().default('index.html'),
    manifest: jsonb('manifest').$type<ManifestEntry[]>().notNull(),
    totalBytes: integer('total_bytes').notNull(),
    fileCount: integer('file_count').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    // §5.2 declares a foreign key to `generations`; that table arrives in S6, which adds the
    // constraint. The column exists now so a generated version needs no schema change then.
    generationId: uuid('generation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('artifact_versions_artifact_id_version_no_unique').on(table.artifactId, table.versionNo),
    check('artifact_versions_status_check', sql`${table.status} in ('pending', 'ready')`),
    // The sweeper's only query: pending versions older than a cutoff.
    index('artifact_versions_status_created_idx').on(table.status, table.createdAt),
  ],
)

export type Artifact = typeof artifacts.$inferSelect
export type NewArtifact = typeof artifacts.$inferInsert
export type ArtifactVersion = typeof artifactVersions.$inferSelect
export type NewArtifactVersion = typeof artifactVersions.$inferInsert
