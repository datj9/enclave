import { S3Client } from '@aws-sdk/client-s3'
import { eq } from 'drizzle-orm'
import { db, pingDatabase } from '@/db'
import { artifacts } from '@/db/schema/artifacts'
import { usageCounters } from '@/db/schema/usage-counters'
import { userProviderKeys } from '@/db/schema/user-provider-keys'
import { users } from '@/db/schema/users'
import { env } from '@/env'
import { createS3ObjectStore, s3ConfigFromEnv } from '@/lib/storage/s3'
import type { ObjectStore } from '@/lib/storage/object-store'

/**
 * Shared setup for the integration suite. These tests hit the real Postgres on `DATABASE_URL` and
 * the real S3-compatible endpoint on `S3_ENDPOINT` — start them with
 * `docker compose --profile minio up -d` and apply migrations with `pnpm db:migrate` first.
 *
 * `probeServices` lets each spec skip itself instead of failing when either is absent.
 */

const PROBE_TIMEOUT_MS = 3000

export interface ServiceAvailability {
  readonly database: boolean
  readonly storage: boolean
}

export async function probeServices(): Promise<ServiceAvailability> {
  const database = await pingDatabase().then(
    () => true,
    () => false,
  )

  const storage = await createTestStore()
    .ensureBucket()
    .then(
      () => true,
      () => false,
    )

  return { database, storage }
}

export function createTestStore(): ObjectStore {
  const config = s3ConfigFromEnv()
  return createS3ObjectStore(
    config,
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestHandler: { requestTimeout: PROBE_TIMEOUT_MS, connectionTimeout: PROBE_TIMEOUT_MS },
      maxAttempts: 1,
    }),
  )
}

/** A store pointed at a port nothing listens on, for the `STORAGE_UNAVAILABLE` path. */
export function createUnreachableStore(): ObjectStore {
  const config = { ...s3ConfigFromEnv(), endpoint: 'http://127.0.0.1:1' }
  return createS3ObjectStore(
    config,
    new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestHandler: { requestTimeout: 500, connectionTimeout: 500 },
      maxAttempts: 1,
    }),
  )
}

export const TEST_OWNER_EMAIL = 'integration-owner@example.test'

/** Vitest runs test files in parallel, so a file that shares this row with another races it into
 *  the `created_by` foreign key. Pass an email of your own to get an owner nobody else deletes. */
export async function createTestOwner(email: string = TEST_OWNER_EMAIL): Promise<string> {
  await db.delete(users).where(eq(users.email, email))

  const [owner] = await db
    .insert(users)
    .values({ email, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (owner === undefined) throw new Error('could not create the integration test owner')
  return owner.id
}

/**
 * Removes only this suite's rows and objects. Truncating `artifacts` would also wipe whatever a
 * developer created by hand while the app was running.
 */
export async function removeTestOwnerData(ownerId: string, store: ObjectStore): Promise<void> {
  const owned = await db
    .select({ id: artifacts.id })
    .from(artifacts)
    .where(eq(artifacts.ownerId, ownerId))

  for (const artifact of owned) {
    await store.deletePrefix(`artifacts/${artifact.id}/`)
  }

  await db.delete(artifacts).where(eq(artifacts.ownerId, ownerId))
  // Written by the generation path for every suite that generates, and both reference `users`,
  // so the delete below fails without them.
  await db.delete(usageCounters).where(eq(usageCounters.userId, ownerId))
  await db.delete(userProviderKeys).where(eq(userProviderKeys.userId, ownerId))
  await db.delete(users).where(eq(users.id, ownerId))
}

export const BUCKET_NAME = env.S3_BUCKET
