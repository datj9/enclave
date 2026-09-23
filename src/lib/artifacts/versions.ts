import { eq, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { recordAuditEvent } from '@/lib/audit'
import { ENTRY_PATH, validateBundle, type BundleFile } from '@/lib/bundle/validate'
import { classifyArtifactVersion } from '@/lib/categories/classify'
import { HttpError } from '@/lib/http'
import type { ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'
import { runAfterResponse } from './after-response'
import {
  currentVersionNoOf,
  markVersionReady,
  totalBytesOf,
  uploadBundleObjects,
} from './bundle-write'
import { CLIENT_MESSAGE_BY_CODE } from './create'
import { artifactViewUrl } from './naming'
import { PENDING_SWEEP_AFTER_MINUTES } from './pending'

const CONFLICT_MESSAGE = 'The artifact has a newer version than expected'
const IN_FLIGHT_MESSAGE = 'Another version of this artifact is still uploading'

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === '23505'
  )
}

type Reader = Pick<typeof db, 'select'>

/**
 * The number of the version readers are currently served, or 0 before the first flip. Reads the
 * pointer rather than `max(version_no)`: pending and abandoned versions are not "current".
 */
async function readCurrentVersionNo(reader: Reader, artifactId: string): Promise<number> {
  const [row] = await reader
    .select({
      currentVersionNo: sql<number>`coalesce(${currentVersionNoOf}, 0)`,
    })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))

  return Number(row?.currentVersionNo ?? 0)
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
 * `expectedVersionNo` present → refuse unless it equals the current (ready, served) version — a
 * lost append race.
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
        .select({
          ownerId: artifacts.ownerId,
          deletedAt: artifacts.deletedAt,
          categorySource: artifacts.categorySource,
          title: artifacts.title,
        })
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

      // The guard compares against the version readers are served (`current_version_id`, always
      // `ready`), because that is what the client saw and built on — not `max(version_no)`, which
      // counts pending rows too, so one abandoned upload used to make every `--expected` push
      // fail until the sweeper ran.
      const currentVersionNo = await readCurrentVersionNo(transaction, input.artifactId)

      if (
        input.expectedVersionNo !== undefined &&
        input.expectedVersionNo !== currentVersionNo
      ) {
        throw new HttpError('VERSION_CONFLICT', CONFLICT_MESSAGE, {
          details: { expectedVersionNo: input.expectedVersionNo, currentVersionNo },
        })
      }

      // The new number is `max + 1` over every row, pending included: the unique index covers
      // them all, so a stuck pending v3 keeps its number until the sweeper reclaims it.
      //
      // `inFlightVersionNo` is the other half of the guard. Another append that passed its own
      // guard and is still uploading has not flipped `current_version_id` yet, so the check above
      // alone would let two clients who both saw v1 each append on top of it. A pending version
      // younger than the sweeper's cutoff is treated as that in-flight append and refused; an
      // older one is an abandoned upload awaiting the sweeper and no longer blocks anyone.
      const [numbers] = await transaction
        .select({
          maxVersionNo: sql<number>`coalesce(max(${artifactVersions.versionNo}), 0)`,
          inFlightVersionNo: sql<number | null>`max(${artifactVersions.versionNo}) filter (where ${artifactVersions.status} = 'pending' and ${artifactVersions.versionNo} > ${currentVersionNo} and ${artifactVersions.createdAt} > now() - make_interval(mins => ${PENDING_SWEEP_AFTER_MINUTES}))`,
        })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, input.artifactId))

      const inFlightVersionNo = numbers?.inFlightVersionNo ?? null
      if (input.expectedVersionNo !== undefined && inFlightVersionNo !== null) {
        throw new HttpError('VERSION_CONFLICT', IN_FLIGHT_MESSAGE, {
          details: {
            expectedVersionNo: input.expectedVersionNo,
            currentVersionNo,
            inFlightVersionNo: Number(inFlightVersionNo),
          },
        })
      }

      const versionNo = Number(numbers?.maxVersionNo ?? 0) + 1

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

      return {
        artifactId: input.artifactId,
        versionId: version.id,
        versionNo,
        categorySource: artifact.categorySource,
        title: artifact.title,
      }
    })
    .catch(async (error: unknown) => {
      if (!isUniqueViolation(error)) throw error

      const currentVersionNo = await readCurrentVersionNo(db, input.artifactId)
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

  // Best-effort model tagging, after the response (inline outside a request) — see
  // `runAfterResponse`. A manually-tagged artifact is the author's own curation: skip
  // re-classification entirely.
  if (version.categorySource !== 'manual') {
    await runAfterResponse(`classify artifact ${version.artifactId}`, () =>
      classifyArtifactVersion({
        artifactId: version.artifactId,
        title: version.title,
        files: input.files,
      }),
    )
  }

  return {
    versionId: version.versionId,
    versionNo: version.versionNo,
    viewUrl: artifactViewUrl(version.artifactId),
  }
}
