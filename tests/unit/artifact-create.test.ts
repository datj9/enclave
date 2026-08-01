import { describe, expect, it } from 'vitest'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { HttpError } from '@/lib/http'
import type { BundleFile } from '@/lib/bundle/validate'
import type { ObjectStore } from '@/lib/storage/object-store'

/**
 * Validation runs before anything is inserted or uploaded, so these cases need neither Postgres
 * nor storage. `refusingStore` is the assertion for "nothing written to storage" (US-6 AC1): any
 * call at all fails the test.
 */

const OWNER_ID = '7f3e0000-0000-4000-8000-000000000001'

const refusingStore: ObjectStore = {
  ensureBucket: () => Promise.reject(new Error('storage must not be touched')),
  putObject: () => Promise.reject(new Error('storage must not be touched')),
  getObject: () => Promise.reject(new Error('storage must not be touched')),
  getObjectStream: () => Promise.reject(new Error('storage must not be touched')),
  presignGetUrl: () => Promise.reject(new Error('storage must not be touched')),
  listKeys: () => Promise.reject(new Error('storage must not be touched')),
  deletePrefix: () => Promise.reject(new Error('storage must not be touched')),
}

function create(files: readonly BundleFile[]) {
  return createArtifactWithBundle(
    { ownerId: OWNER_ID, title: 'Rejected', visibility: 'private', files },
    refusingStore,
  )
}

function file(path: string, content = 'x'): BundleFile {
  return { path, content: Buffer.from(content, 'utf8') }
}

const entry = () => file('index.html', '<!doctype html>')

describe('createArtifactWithBundle · rejection before any write', () => {
  it.each([
    ['PATH_INVALID', 422, [entry(), file('../../etc/passwd')]],
    ['FILE_TYPE_NOT_ALLOWED', 422, [entry(), file('shell.php')]],
    ['ENTRY_MISSING', 422, [file('app.js')]],
    ['VALIDATION_FAILED', 422, [entry(), file('app.js', 'a'), file('app.js', 'b')]],
    [
      'BUNDLE_TOO_LARGE',
      413,
      [entry(), { path: 'big.js', content: Buffer.alloc(2_097_153, 0x61) }],
    ],
  ])('throws %s with status %i', async (code, status, files) => {
    const error = await create(files as BundleFile[]).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code, status })
  })

  it('carries the validator details through so the caller can fix the bundle', async () => {
    const error = (await create([entry(), file('../../etc/passwd')]).catch(
      (thrown: unknown) => thrown,
    )) as HttpError

    expect(error.details).toEqual({ path: '../../etc/passwd' })
  })

  it('reports a client-safe message that names no internals', async () => {
    const error = (await create([file('app.js')]).catch((thrown: unknown) => thrown)) as HttpError

    expect(error.message).toBe('The bundle must contain index.html')
  })
})
