import { eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { recordAuditEvent } from '@/lib/audit'
import { ENTRY_PATH, validateBundle, type BundleFile } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'
import type { ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'
import { markVersionReady, totalBytesOf, uploadBundleObjects } from './bundle-write'
import { CLIENT_MESSAGE_BY_CODE } from './create'
import { artifactViewUrl } from './naming'

const CONFLICT_MESSAGE = 'The artifact has a newer version than expected'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  )
}

export interface AppendVersionInput {
  readonly artifactId: string
  readonly ownerId: string
  readonly files: readonly BundleFile[]
  readonly expectedVersionNo?: number
  readonly actorIp?: string | null
}

export interface AppendedVersion {
  readonly versionId: string
  readonly versionNo: number
  readonly viewUrl: string
}

/**
 * The S15 append path: version N+1 at the same `viewUrl`. Mirrors the create flow's ordering —
 * row first, objects, then the flip — so a failure mid-upload leaves a `pending` version and
 * `current_version_id` pointing at the previous version, and the sweeper reclaims the orphan.
 *
 * `expectedVersionNo` present → refuse unless it equals the current version (a lost append race).
 * Absent → unconditional append (`--force`). The unique btree on `(artifact_id, version_no)` is
 * the backstop for a concurrent append that slips between the guard and the insert.
 */
export async function appendVersion(
  input: AppendVersionInput,
  store: ObjectStore = objectStore(),
): Promise<AppendedVersion> {
  const validation = validateBundle(input.files)
  if (!validation.ok) {
    throw new HttpError(
      validation.code,
      CLIENT_MESSAGE_BY_CODE[validation.code] ?? 'The bundle is not valid',
      { details: validation.details },
    )
  }

  const manifest = validation.manifest

  const version = await db
    .transaction(async (transaction) => {
      const [artifact] = await transaction
        .select({ ownerId: artifacts.ownerId, deletedAt: artifacts.deletedAt })
        .from(artifacts)
        .where(eq(artifacts.id, input.artifactId))
        .for('update')

      if (
        artifact === undefined ||
        artifact.deletedAt !== null ||
        artifact.ownerId !== input.ownerId
      ) {
        // 404, never 403: the endpoint must not confirm an artifact exists to a non-owner.
        throw new HttpError('NOT_FOUND', 'Artifact not found')
      }

      const [maxRow] = await transaction
        .select({ currentVersionNo: sql<number>`coalesce(max(${artifactVersions.versionNo}), 0)` })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, input.artifactId))

      const currentVersionNo = maxRow?.currentVersionNo ?? 0

      if (
        input.expectedVersionNo !== undefined &&
        input.expectedVersionNo !== currentVersionNo
      ) {
        throw new HttpError('VERSION_CONFLICT', CONFLICT_MESSAGE, {
          details: { expectedVersionNo: input.expectedVersionNo, currentVersionNo },
        })
      }

      const versionNo = currentVersionNo + 1

      const [version] = await transaction
        .insert(artifactVersions)
        .values({
          artifactId: input.artifactId,
          versionNo,
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

      return { artifactId: input.artifactId, versionId: version.id, versionNo }
    })
    .catch(async (error: unknown) => {
      if (!isUniqueViolation(error)) throw error

      const [maxRow] = await db
        .select({ currentVersionNo: sql<number>`coalesce(max(${artifactVersions.versionNo}), 0)` })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, input.artifactId))

      const currentVersionNo = maxRow?.currentVersionNo ?? 0
      throw new HttpError('VERSION_CONFLICT', CONFLICT_MESSAGE, {
        details: {
          ...(input.expectedVersionNo === undefined
            ? {}
            : { expectedVersionNo: input.expectedVersionNo }),
          currentVersionNo,
        },
      })
    })

  await uploadBundleObjects(store, version, input.files, manifest)
  await markVersionReady(version)

  await recordAuditEvent({
    action: 'version.create',
    actorUserId: input.ownerId,
    actorIp: input.actorIp ?? null,
    artifactId: version.artifactId,
    versionId: version.versionId,
    metadata: { versionNo: version.versionNo, fileCount: manifest.length },
  })

  return {
    versionId: version.versionId,
    versionNo: version.versionNo,
    viewUrl: artifactViewUrl(version.artifactId),
  }
}
