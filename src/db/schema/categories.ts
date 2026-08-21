import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { artifacts } from './artifacts'
import { users } from './users'

/**
 * Admin-managed artifact categories. Soft-deleted via `isActive` — nothing is ever hard-deleted
 * through the API. The slug is derived from the name, so `Docs` and `docs` collide on the slug
 * unique index; there is deliberately no unique index on `lower(name)`.
 */
export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('categories_slug_unique').on(table.slug),
    index('categories_is_active_idx').on(table.isActive),
  ],
)

export const artifactCategories = pgTable(
  'artifact_categories',
  {
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.artifactId, table.categoryId] }),
    index('artifact_categories_category_idx').on(table.categoryId),
  ],
)

export type Category = typeof categories.$inferSelect
export type NewCategory = typeof categories.$inferInsert
export type ArtifactCategory = typeof artifactCategories.$inferSelect
export type NewArtifactCategory = typeof artifactCategories.$inferInsert
