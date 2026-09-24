import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3'
import postgres from 'postgres'
import { isCi, missingServicesMessage } from './ci'

/**
 * Integration-project global setup: runs once, in the main vitest process, before any file in
 * tests/integration/**.
 *
 * Each spec skips itself when Postgres or object storage is unreachable, which is right on a laptop
 * with nothing started and wrong in CI: there a skip means the service containers failed, and the
 * run would still report green. Throwing here fails the run instead, without touching the ~30
 * files' individual skip logic.
 *
 * Deliberately a global setup and deliberately free of `@/…` imports. A per-file setup file that
 * imported `./services` would load `@/env` and `@/db` before the spec body runs, so every spec that
 * sets `process.env.*` or calls `vi.mock` ahead of its own imports (the OIDC and password-reset
 * suites do both) would get a module graph frozen with the wrong values. Here the probes use the
 * drivers directly, against the same variables the app reads, and close what they open.
 */

const PROBE_TIMEOUT_MS = 3000

export default async function requireServicesInCi(): Promise<void> {
  if (!isCi()) return

  // Same precedence as tests/unit/setup-env.ts: `.env` first, then its fallbacks.
  await import('../unit/setup-env')

  const [database, storage] = await Promise.all([probeDatabase(), probeStorage()])
  const message = missingServicesMessage({ database, storage })
  if (message !== null) throw new Error(message)
}

async function probeDatabase(): Promise<boolean> {
  const sql = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    connect_timeout: PROBE_TIMEOUT_MS / 1000,
    onnotice: () => {},
  })
  try {
    await sql`select 1`
    return true
  } catch {
    return false
  } finally {
    await sql.end({ timeout: 1 })
  }
}

async function probeStorage(): Promise<boolean> {
  const client = new S3Client({
    // Always set by the time this runs — setup-env.ts supplies fallbacks for both.
    endpoint: process.env.S3_ENDPOINT ?? '',
    region: process.env.S3_REGION ?? '',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    },
    requestHandler: { requestTimeout: PROBE_TIMEOUT_MS, connectionTimeout: PROBE_TIMEOUT_MS },
    maxAttempts: 1,
  })
  try {
    // Answers only with a reachable endpoint AND valid credentials — the two things every
    // storage-backed spec needs. The bucket itself is created by the specs (ensureBucket).
    await client.send(new ListBucketsCommand({}))
    return true
  } catch {
    return false
  } finally {
    client.destroy()
  }
}
