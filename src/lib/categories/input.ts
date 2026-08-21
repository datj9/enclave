import { z } from 'zod'

import { HttpError } from '@/lib/http'

import { slugFromCategoryName } from '@/lib/categories/naming'

function invalidBody(issues: readonly z.ZodIssue[]): never {
  throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
    details: {
      fields: issues.map((issue) => issue.path.join('.') || '(root)'),
    },
  })
}

const categoryBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(500).optional(),
  })
  .strict()

export function parseCategoryBody(body: unknown): {
  readonly name: string
  readonly description: string | null
} {
  const parsed = categoryBodySchema.safeParse(body)
  if (!parsed.success) {
    invalidBody(parsed.error.issues)
  }
  if (slugFromCategoryName(parsed.data.name) === null) {
    invalidBody([{ path: ['name'] } as z.ZodIssue])
  }
  return {
    name: parsed.data.name,
    description: parsed.data.description === undefined || parsed.data.description === '' ? null : parsed.data.description,
  }
}

const categoryPatchBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.description !== undefined || value.isActive !== undefined, {
    message: 'at least one field is required',
  })

export function parseCategoryPatchBody(body: unknown): {
  readonly name?: string
  readonly description?: string | null
  readonly isActive?: boolean
} {
  const parsed = categoryPatchBodySchema.safeParse(body)
  if (!parsed.success) {
    invalidBody(parsed.error.issues)
  }
  return {
    ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
    ...(parsed.data.description === undefined
      ? {}
      : { description: parsed.data.description === '' ? null : parsed.data.description }),
    ...(parsed.data.isActive === undefined ? {} : { isActive: parsed.data.isActive }),
  }
}
