import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'
import { storageKey, versionPrefix, type ObjectStore } from '@/lib/storage/object-store'
import { BUCKET_NAME, createTestStore, createUnreachableStore, probeServices } from './services'

/** The S3 adapter itself, against real object storage — the parts a mocked SDK cannot vouch for. */

const { storage } = await probeServices()

const ARTIFACT_ID = 'integration-s3-artifact'
const VERSION_ID = 'v1'
const PREFIX = versionPrefix(ARTIFACT_ID, VERSION_ID)

describe.skipIf(!storage)('createS3ObjectStore', () => {
  let store: ObjectStore

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
    await store.deletePrefix(PREFIX)
  })

  afterAll(async () => {
    await store.deletePrefix(PREFIX)
  })

  it('is idempotent about the bucket, so every boot can call it', async () => {
    await expect(store.ensureBucket()).resolves.toBeUndefined()
    await expect(store.ensureBucket()).resolves.toBeUndefined()
  })

  it('round-trips bytes and preserves the declared content type', async () => {
    const key = storageKey(ARTIFACT_ID, VERSION_ID, 'assets/logo.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    await store.putObject({ key, body: bytes, contentType: 'image/png' })
    const fetched = await store.getObject(key)

    expect(fetched?.body.equals(bytes)).toBe(true)
    expect(fetched?.contentType).toBe('image/png')
  })

  it('returns undefined for a key that was never written', async () => {
    expect(await store.getObject(storageKey(ARTIFACT_ID, VERSION_ID, 'absent.txt'))).toBeUndefined()
  })

  it('lists exactly the keys under a version prefix', async () => {
    await store.putObject({
      key: storageKey(ARTIFACT_ID, VERSION_ID, 'index.html'),
      body: Buffer.from('<!doctype html>', 'utf8'),
      contentType: 'text/html',
    })

    const keys = await store.listKeys(PREFIX)

    expect(keys).toContain(`${PREFIX}index.html`)
    expect(keys).toContain(`${PREFIX}assets/logo.png`)
    for (const key of keys) expect(key.startsWith(PREFIX)).toBe(true)
  })

  it('deletes a whole prefix and treats an empty prefix as a no-op', async () => {
    await store.deletePrefix(PREFIX)

    expect(await store.listKeys(PREFIX)).toEqual([])
    await expect(store.deletePrefix(PREFIX)).resolves.toBeUndefined()
  })
})

describe.skipIf(!storage)('createS3ObjectStore · unreachable endpoint', () => {
  it.each([
    ['putObject', (store: ObjectStore) => store.putObject({ key: 'k', body: Buffer.alloc(0), contentType: 'text/plain' })],
    ['getObject', (store: ObjectStore) => store.getObject('k')],
    ['listKeys', (store: ObjectStore) => store.listKeys('artifacts/')],
    ['deletePrefix', (store: ObjectStore) => store.deletePrefix('artifacts/')],
    ['ensureBucket', (store: ObjectStore) => store.ensureBucket()],
  ])('maps a %s failure to STORAGE_UNAVAILABLE and leaks nothing', async (_label, call) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const unreachable = createUnreachableStore()

    const error = (await call(unreachable).catch((thrown: unknown) => thrown)) as HttpError

    expect(error).toBeInstanceOf(HttpError)
    expect(error.code).toBe('STORAGE_UNAVAILABLE')
    expect(error.status).toBe(503)
    expect(error.message).toBe('Storage is unavailable, please retry')
    expect(error.message).not.toContain(BUCKET_NAME)
    // The endpoint and the driver's detail belong in the server log, not the response.
    expect(consoleError).toHaveBeenCalled()

    vi.restoreAllMocks()
  })
})
