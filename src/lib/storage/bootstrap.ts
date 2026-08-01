import type { ObjectStore } from './object-store'
import { objectStore } from './s3'

/**
 * Creates the bucket if it is absent, so `docker compose --profile minio up` needs no console
 * visit before the first upload (US-1: a clean machine gives a working instance).
 *
 * Soft on purpose — it runs from `instrumentation.ts`, which is diagnostics only. A bucket that
 * cannot be reached at boot must not stop the app serving sign-in; the first upload then answers
 * `503 STORAGE_UNAVAILABLE`, which is the specified behaviour.
 */
export async function ensureArtifactBucket(store: ObjectStore = objectStore()): Promise<boolean> {
  try {
    await store.ensureBucket()
    return true
  } catch {
    console.warn(
      '[enclave] object storage is not reachable at boot. Check S3_ENDPOINT and the bucket in ' +
        'S3_BUCKET; uploads will answer 503 until it responds.',
    )
    return false
  }
}
