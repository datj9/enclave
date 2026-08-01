import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureArtifactBucket } from '@/lib/storage/bootstrap'
import { HttpError } from '@/lib/http'
import type { ObjectStore } from '@/lib/storage/object-store'

function storeWhoseEnsureBucket(behaviour: () => Promise<void>): ObjectStore {
  return {
    ensureBucket: behaviour,
    putObject: () => Promise.reject(new Error('not used')),
    getObject: () => Promise.reject(new Error('not used')),
    getObjectStream: () => Promise.reject(new Error('not used')),
    presignGetUrl: () => Promise.reject(new Error('not used')),
    listKeys: () => Promise.reject(new Error('not used')),
    deletePrefix: () => Promise.reject(new Error('not used')),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ensureArtifactBucket', () => {
  it('reports success when the bucket is present or created', async () => {
    await expect(ensureArtifactBucket(storeWhoseEnsureBucket(() => Promise.resolve()))).resolves.toBe(
      true,
    )
  })

  it('warns and keeps the app bootable when storage is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unreachable = storeWhoseEnsureBucket(() =>
      Promise.reject(new HttpError('STORAGE_UNAVAILABLE', 'Storage is unavailable, please retry')),
    )

    await expect(ensureArtifactBucket(unreachable)).resolves.toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    // The warning names the variables to check, never the bucket's value (§8).
    expect(warn.mock.calls[0]?.[0]).toContain('S3_ENDPOINT')
  })
})
