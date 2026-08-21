import { asc, eq } from 'drizzle-orm'

import { db } from '@/db'
import { categories } from '@/db/schema/categories'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'

import { slugFromCategoryName } from './naming'

export interface CategoryView {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly description: string | null
  readonly isActive: boolean
  readonly createdAt: string
}

export interface CreateCategoryInput {
  readonly name: string
  readonly description: string | null
  readonly createdBy: string
  readonly actorIp?: string | null
}

export interface UpdateCategoryInput {
  readonly categoryId: string
  readonly name?: string
  readonly description?: string | null
  readonly isActive?: boolean
  readonly actorId: string
  readonly actorIp?: string | null
}

const DUPLICATE_MESSAGE = 'A category with that name already exists'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  )
}

function duplicateError(): HttpError {
  return new HttpError('VALIDATION_FAILED', DUPLICATE_MESSAGE, {
    details: { fields: ['name'] },
  })
}

function toView(row: {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly description: string | null
  readonly isActive: boolean
  readonly createdAt: Date
}): CategoryView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listCategories(options: {
  readonly includeInactive: boolean
}): Promise<readonly CategoryView[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      isActive: categories.isActive,
      createdAt: categories.createdAt,
    })
    .from(categories)
    .where(options.includeInactive ? undefined : eq(categories.isActive, true))
    .orderBy(asc(categories.name))

  return rows.map(toView)
}

export async function createCategory(input: CreateCategoryInput): Promise<CategoryView> {
  const slug = slugFromCategoryName(input.name)
  if (slug === null) {
    throw new HttpError('VALIDATION_FAILED', 'The category name is not valid', {
      details: { fields: ['name'] },
    })
  }

  const existing = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .limit(1)
  if (existing[0] !== undefined) throw duplicateError()

  let row: {
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly description: string | null
    readonly isActive: boolean
    readonly createdAt: Date
  } | undefined
  try {
    ;[row] = await db
      .insert(categories)
      .values({
        name: input.name,
        slug,
        description: input.description,
        createdBy: input.createdBy,
      })
      .returning({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        description: categories.description,
        isActive: categories.isActive,
        createdAt: categories.createdAt,
      })
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateError()
    throw error
  }

  if (row === undefined) throw new HttpError('INTERNAL_ERROR', 'Could not create the category')

  await recordAuditEvent({
    action: 'category.create',
    actorUserId: input.createdBy,
    actorIp: input.actorIp ?? null,
    metadata: { categoryId: row.id, name: row.name, slug: row.slug },
  })

  return toView(row)
}

export async function updateCategory(input: UpdateCategoryInput): Promise<CategoryView> {
  let slug: string | undefined
  if (input.name !== undefined) {
    const derived = slugFromCategoryName(input.name)
    if (derived === null) {
      throw new HttpError('VALIDATION_FAILED', 'The category name is not valid', {
        details: { fields: ['name'] },
      })
    }
    slug = derived
  }

  if (slug !== undefined) {
    const heldBy = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)
    if (heldBy[0] !== undefined && heldBy[0].id !== input.categoryId) throw duplicateError()
  }

  let rows: {
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly description: string | null
    readonly isActive: boolean
    readonly createdAt: Date
  }[]
  try {
    rows = await db
      .update(categories)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(slug === undefined ? {} : { slug }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: new Date(),
      })
      .where(eq(categories.id, input.categoryId))
      .returning({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        description: categories.description,
        isActive: categories.isActive,
        createdAt: categories.createdAt,
      })
  } catch (error) {
    if (isUniqueViolation(error)) throw duplicateError()
    throw error
  }

  const row = rows[0]
  if (row === undefined) throw new HttpError('NOT_FOUND', 'That category does not exist')

  await recordAuditEvent({
    action: 'category.update',
    actorUserId: input.actorId,
    actorIp: input.actorIp ?? null,
    metadata: { categoryId: row.id, name: row.name, slug: row.slug },
  })

  return toView(row)
}
