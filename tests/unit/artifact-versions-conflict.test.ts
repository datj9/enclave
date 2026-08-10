import { describe, expect, it, vi } from 'vitest'

import type { BundleFile } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'

/**
 * The 23505 mapping with Postgres mocked out. `appendVersion` holds `FOR UPDATE` on the artifact
 * row, so a real append can never race the unique index — this branch is defence in depth. The
 * mocked transaction rejects with the exact shape Postgres raises and the `.catch` must convert
 * it to a 409, not a 500.
 */

vi.mock('@/db', () => {
  const uniqueViolation = Object.assign(
    new Error('duplicate key value violates unique constraint'),
    {
      code: '23505',
      constraint_name: 'artifact_versions_artifact_id_version_no_unique',
    },
  )

  return {
    db: {
      transaction: () => Promise.reject(uniqueViolation),
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ currentVersionNo: 2 }]),
        }),
      }),
    },
  }
})

const { appendVersion } = await import('@/lib/artifacts/versions')

function entry(): BundleFile {
  return { path: 'index.html', content: Buffer.from('<!doctype html>', 'utf8') }
}

describe('appendVersion · 23505 unique violation mapping', () => {
  it('maps a 23505 unique violation to VERSION_CONFLICT, not a 500', async () => {
    const failure = await appendVersion({
      artifactId: '11111111-2222-4333-8444-555555555555',
      ownerId: '7f3e0000-0000-4000-8000-000000000001',
      files: [entry()],
    }).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    const httpError = failure as HttpError
    expect(httpError.code).toBe('VERSION_CONFLICT')
    expect(httpError.status).toBe(409)
    expect(httpError.status).not.toBe(500)
    expect(httpError.code).not.toBe('INTERNAL_ERROR')
    expect(httpError.details).toEqual({ currentVersionNo: 2 })
  })
})
