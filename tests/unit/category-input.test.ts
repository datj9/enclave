import { describe, expect, it } from 'vitest'

import { HttpError } from '@/lib/http'
import { parseCategoryBody, parseCategoryPatchBody } from '@/lib/categories/input'

/**
 * Spec: categories-taxonomy §`parseCategoryBody` / §`parseCategoryPatchBody`
 * (src/lib/categories/input.ts). Per contract, both throw
 * `HttpError('VALIDATION_FAILED', …, { details: { fields: [...] } })` where `fields` is
 * `issues.map((issue) => issue.path.join('.') || '(root)')`. All tests are [must-fail] at RED:
 * the module does not exist yet.
 */

function expectRejectedWithFields(call: () => unknown): string[] {
  try {
    call()
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError)
    const httpError = error as HttpError
    expect(httpError.code).toBe('VALIDATION_FAILED')
    const fields = (httpError.details?.fields as string[] | undefined) ?? []
    expect(fields.length).toBeGreaterThan(0)
    return fields
  }
  throw new Error('expected the call to throw')
}

describe('parseCategoryBody', () => {
  it('parseCategoryBody trims the name and defaults description to null', () => {
    expect(parseCategoryBody({ name: 'Docs', description: 'Reference pages' })).toEqual({
      name: 'Docs',
      description: 'Reference pages',
    })
    expect(parseCategoryBody({ name: '  Docs  ' })).toEqual({ name: 'Docs', description: null })
    expect(parseCategoryBody({ name: 'Docs', description: '' })).toEqual({
      name: 'Docs',
      description: null,
    })
  })

  it('parseCategoryBody rejects an empty name naming only the name field', () => {
    expect(expectRejectedWithFields(() => parseCategoryBody({ name: '' }))).toEqual(['name'])
  })

  it('parseCategoryBody rejects a name over sixty characters', () => {
    expect(expectRejectedWithFields(() => parseCategoryBody({ name: 'x'.repeat(61) }))).toEqual([
      'name',
    ])
  })

  it('parseCategoryBody rejects a name with no slug-able characters', () => {
    expect(expectRejectedWithFields(() => parseCategoryBody({ name: '!!!' }))).toEqual(['name'])
  })

  it('parseCategoryBody rejects an unknown field', () => {
    expectRejectedWithFields(() => parseCategoryBody({ name: 'Docs', colour: 'red' }))
  })
})

describe('parseCategoryPatchBody', () => {
  it('parseCategoryPatchBody accepts isActive on its own', () => {
    expect(parseCategoryPatchBody({ isActive: false })).toEqual({ isActive: false })
  })

  it('parseCategoryPatchBody rejects an empty object naming the root', () => {
    expect(expectRejectedWithFields(() => parseCategoryPatchBody({}))).toEqual(['(root)'])
  })
})