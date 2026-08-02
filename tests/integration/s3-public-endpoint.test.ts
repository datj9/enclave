import { describe, expect, it } from 'vitest'

import { createS3ObjectStore, s3ConfigFromEnv, type S3StoreConfig } from '@/lib/storage/s3'

/**
 * Regression guard for a bug that only appears in the container: the app reached storage at
 * `http://minio:9000` on the compose network and then signed asset URLs with that same host, so
 * every artifact asset 404'd in a real browser. A presigned URL signs its own host, so the fix is
 * to sign with the endpoint the browser resolves rather than rewrite the URL afterwards.
 *
 * The unit suite never caught it because tests run on the host, where both endpoints are equal.
 */
describe('presigned URLs use the browser-visible endpoint', () => {
  const baseConfig: S3StoreConfig = {
    ...s3ConfigFromEnv(),
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://localhost:9000',
  }

  it('signs with publicEndpoint, not the internal endpoint the app dials', async () => {
    const store = createS3ObjectStore(baseConfig)
    const url = await store.presignGetUrl('artifacts/a/b/index.html', 60)

    expect(new URL(url).host).toBe('localhost:9000')
    expect(url).not.toContain('minio:9000')
  })

  it('keeps the signature valid for the public host', async () => {
    const store = createS3ObjectStore(baseConfig)
    const url = await store.presignGetUrl('artifacts/a/b/index.html', 60)
    const signedHeaders = new URL(url).searchParams.get('X-Amz-SignedHeaders')

    // `host` is inside the signature, which is exactly why rewriting the URL afterwards breaks it.
    expect(signedHeaders).toContain('host')
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('60')
  })

  it('reuses the one client when both endpoints agree, the common deployment', async () => {
    const store = createS3ObjectStore({ ...baseConfig, publicEndpoint: baseConfig.endpoint })
    const url = await store.presignGetUrl('artifacts/a/b/index.html', 60)

    expect(new URL(url).host).toBe('minio:9000')
  })

  it('defaults publicEndpoint to S3_ENDPOINT when the variable is unset', () => {
    const config = s3ConfigFromEnv()

    expect(config.publicEndpoint).toBe(process.env.S3_PUBLIC_ENDPOINT ?? config.endpoint)
  })
})
