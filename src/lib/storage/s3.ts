import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import { env } from '@/env'
import { HttpError } from '@/lib/http'
import type { FetchedObject, ObjectStore, PutObjectInput } from './object-store'

/**
 * The one S3-compatible adapter (decision #11/#16: AWS S3, GCS, R2, B2, MinIO all work).
 *
 * Every driver failure collapses to `STORAGE_UNAVAILABLE` with a fixed message. The bucket name,
 * the endpoint and the driver's stack never reach a client (§8 error hygiene) — they go to the
 * server log instead.
 */

const STORAGE_UNAVAILABLE_MESSAGE = 'Storage is unavailable, please retry'

/** S3 caps a single DeleteObjects call at 1000 keys. */
const DELETE_BATCH_SIZE = 1000

export interface S3StoreConfig {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly forcePathStyle: boolean
}

export function s3ConfigFromEnv(): S3StoreConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  }
}

function createClient(config: S3StoreConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'
}

async function withStorageErrors<TResult>(
  operation: string,
  run: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await run()
  } catch (error) {
    console.error(`[enclave] object storage ${operation} failed — ${errorSummary(error)}`)
    throw new HttpError('STORAGE_UNAVAILABLE', STORAGE_UNAVAILABLE_MESSAGE)
  }
}

function isMissingObject(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')
}

function isBucketAlreadyThere(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'BucketAlreadyOwnedByYou' || error.name === 'BucketAlreadyExists')
  )
}

async function ensureBucket(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }))
    return
  } catch {
    // A missing bucket and an unreachable endpoint both land here; the create below tells them
    // apart by either succeeding or throwing a real connection error.
  }

  await withStorageErrors('ensure-bucket', async () => {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
    } catch (error) {
      // Two processes booting together both see a missing bucket; one loses the race.
      if (!isBucketAlreadyThere(error)) throw error
    }
  })
}

async function listKeys(client: S3Client, bucket: string, prefix: string): Promise<string[]> {
  return withStorageErrors('list', async () => {
    const keys: string[] = []
    let continuationToken: string | undefined

    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      )
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key)
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined
    } while (continuationToken !== undefined)

    return keys
  })
}

async function deleteKeys(client: S3Client, bucket: string, keys: readonly string[]): Promise<void> {
  await withStorageErrors('delete', async () => {
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE)
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      )
    }
  })
}

async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<FetchedObject | undefined> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    const bytes = await response.Body?.transformToByteArray()
    if (bytes === undefined) return undefined
    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType ?? 'application/octet-stream',
    }
  } catch (error) {
    if (isMissingObject(error)) return undefined
    console.error(`[enclave] object storage get failed — ${errorSummary(error)}`)
    throw new HttpError('STORAGE_UNAVAILABLE', STORAGE_UNAVAILABLE_MESSAGE)
  }
}

export function createS3ObjectStore(
  config: S3StoreConfig,
  client: S3Client = createClient(config),
): ObjectStore {
  const { bucket } = config

  return {
    ensureBucket: () => ensureBucket(client, bucket),
    putObject: (input: PutObjectInput) =>
      withStorageErrors('put', async () => {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
          }),
        )
      }),
    getObject: (key: string) => getObject(client, bucket, key),
    listKeys: (prefix: string) => listKeys(client, bucket, prefix),
    deletePrefix: async (prefix: string) => {
      const keys = await listKeys(client, bucket, prefix)
      if (keys.length === 0) return
      await deleteKeys(client, bucket, keys)
    },
  }
}

let cachedStore: ObjectStore | undefined

/**
 * Process-wide store built from the environment. Lazy for the same reason `db` is: `next build`
 * evaluates route modules with no environment at all.
 */
export function objectStore(): ObjectStore {
  cachedStore ??= createS3ObjectStore(s3ConfigFromEnv())
  return cachedStore
}
