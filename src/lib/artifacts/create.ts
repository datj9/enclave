import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts, type Visibility } from '@/db/schema/artifacts'
import { recordAuditEvent } from '@/lib/audit'
import { ENTRY_PATH, validateBundle, type BundleFile, type ManifestEntry } from '@/lib/bundle/validate'
import { HttpError, type ErrorCode } from '@/lib/http'
import { storageKey, type ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'
import { artifactViewUrl, slugFromTitle } from './naming'

/**
 * The atomic write from decision #21 and the S2 worked example: insert the artifact plus a
 * `pending` version, upload every object, then flip the version to `ready` and only then point
 * `current_version_id` at it.
 *
 * If any upload fails the version stays `pending` and `current_version_id` stays NULL, so the
 * artifact is invisible to the list and the sweeper reclaims it.
 */

const FIRST_VERSION_NO = 1

const CLIENT_MESSAGE_BY_CODE: Readonly<Partial<Record<ErrorCode, string>>> = {
  PATH_INVALID: 'A file path in the bundle is not allowed',
  FILE_TYPE_NOT_ALLOWED: 'A file type in the bundle is not allowed',
  ENTRY_MISSING: `The bundle must contain ${ENTRY_PATH}`,
  BUNDLE_TOO_LARGE: 'The bundle exceeds the allowed size',
  VALIDATION_FAILED: 'The bundle is not valid',
}

export interface CreateArtifactInput {
  readonly ownerId: string
  readonly title: string
  readonly visibility: Visibility
  readonly files: readonly BundleFile[]
  readonly actorIp?: string | null
}

export interface CreatedArtifact {
  readonly id: string
  readonly versionId: string
  readonly viewUrl: string
}

interface PendingVersion {
  readonly artifactId: string
  readonly versionId: string
}

function totalBytesOf(manifest: readonly ManifestEntry[]): number {
  return manifest.reduce((runningTotal, entry) => runningTotal + entry.bytes, 0)
}

async function insertPendingVersion(
  input: CreateArtifactInput,
  manifest: readonly ManifestEntry[],
): Promise<PendingVersion> {
  return db.transaction(async (transaction) => {
    const [artifact] = await transaction
      .insert(artifacts)
      .values({
        ownerId: input.ownerId,
        title: input.title,
        slug: slugFromTitle(input.title),
        visibility: input.visibility,
      })
      .returning({ id: artifacts.id })

    if (artifact === undefined) {
      throw new HttpError('INTERNAL_ERROR', 'Could not create the artifact')
    }

    const [version] = await transaction
      .insert(artifactVersions)
      .values({
        artifactId: artifact.id,
        versionNo: FIRST_VERSION_NO,
        status: 'pending',
        entryPath: ENTRY_PATH,
        manifest: [...manifest],
        totalBytes: totalBytesOf(manifest),
        fileCount: manifest.length,
        createdBy: input.ownerId,
      })
      .returning({ id: artifactVersions.id })

    if (version === undefined) {
      throw new HttpError('INTERNAL_ERROR', 'Could not create the artifact version')
    }

    return { artifactId: artifact.id, versionId: version.id }
  })
}

/**
 * Sequential on purpose: a partial upload must leave a deterministic prefix behind so a retry or
 * the sweeper cleans up the same set of keys, and 50 parallel PUTs would only starve the pool.
 */
async function uploadBundleObjects(
  store: ObjectStore,
  version: PendingVersion,
  files: readonly BundleFile[],
  manifest: readonly ManifestEntry[],
): Promise<void> {
  for (const [index, file] of files.entries()) {
    const entry = manifest[index]
    if (entry === undefined) throw new HttpError('INTERNAL_ERROR', 'Manifest is out of step')

    await store.putObject({
      key: storageKey(version.artifactId, version.versionId, file.path),
      body: file.content,
      contentType: entry.content_type,
    })
  }
}

async function markVersionReady(version: PendingVersion): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction
      .update(artifactVersions)
      .set({ status: 'ready' })
      .where(eq(artifactVersions.id, version.versionId))

    await transaction
      .update(artifacts)
      .set({ currentVersionId: version.versionId, updatedAt: new Date() })
      .where(eq(artifacts.id, version.artifactId))
  })
}

export async function createArtifactWithBundle(
  input: CreateArtifactInput,
  store: ObjectStore = objectStore(),
): Promise<CreatedArtifact> {
  const validation = validateBundle(input.files)
  if (!validation.ok) {
    throw new HttpError(
      validation.code,
      CLIENT_MESSAGE_BY_CODE[validation.code] ?? 'The bundle is not valid',
      { details: validation.details },
    )
  }

  const version = await insertPendingVersion(input, validation.manifest)
  await uploadBundleObjects(store, version, input.files, validation.manifest)
  await markVersionReady(version)

  const actorIp = input.actorIp ?? null
  await recordAuditEvent({
    action: 'artifact.create',
    actorUserId: input.ownerId,
    actorIp,
    artifactId: version.artifactId,
    metadata: { visibility: input.visibility },
  })
  await recordAuditEvent({
    action: 'version.create',
    actorUserId: input.ownerId,
    actorIp,
    artifactId: version.artifactId,
    versionId: version.versionId,
    metadata: { versionNo: FIRST_VERSION_NO, fileCount: validation.manifest.length },
  })

  return {
    id: version.artifactId,
    versionId: version.versionId,
    viewUrl: artifactViewUrl(version.artifactId),
  }
}
