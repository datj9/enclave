import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { VISIBILITIES, artifacts, type Visibility } from '@/db/schema/artifacts'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError } from '@/lib/http'
import { authorizeArtifactRead, loadArtifactForRead, resolveViewer } from './authorize'
import { canRead, type Viewer } from './can-read'
import { artifactViewUrl, slugFromTitle } from './naming'

/**
 * `PATCH /api/v1/artifacts/{id}` (§5.3): the only way an artifact's visibility changes, and the
 * only writer of `artifact.visibility_change`.
 *
 * Ordering is the whole point of this module. `canRead` runs first and a failure is a 404, so a
 * stranger cannot tell a private artifact from one that never existed; only a viewer who may
 * already read the artifact can earn the 403 that says "yes, but not yours".
 */

const MAX_TITLE_LENGTH = 200

export const updateArtifactBodySchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
  })
  // Unknown keys are refused rather than ignored: a caller who misspells `visibility` must not
  // get a 200 that silently changed nothing.
  .strict()
  .refine(
    (body) => body.title !== undefined || body.visibility !== undefined,
    { message: 'Provide at least one of title or visibility' },
  )

export type UpdateArtifactPatch = z.infer<typeof updateArtifactBodySchema>

export type UpdateArtifactParse =
  | { readonly ok: true; readonly value: UpdateArtifactPatch }
  | { readonly ok: false; readonly details: Record<string, unknown> }

export function parseUpdateArtifactBody(body: unknown): UpdateArtifactParse {
  const parsed = updateArtifactBodySchema.safeParse(body)
  if (parsed.success) return { ok: true, value: parsed.data }

  return {
    ok: false,
    details: { fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') },
  }
}

export interface ArtifactView {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly visibility: Visibility
  readonly createdAt: string
  readonly updatedAt: string
  readonly viewUrl: string
}

export interface UpdateArtifactInput {
  readonly artifactId: string
  readonly viewerRef: string
  readonly patch: UpdateArtifactPatch
  readonly actorIp?: string | null
}

/** A share-token viewer owns nothing, so it never reaches a write path. */
function writerUserId(viewer: Viewer): string | null {
  if (viewer.kind === 'user') return viewer.id
  if (viewer.kind === 'apiToken') return viewer.userId
  return null
}

/** Both write paths share this: unreadable is 404, readable-but-not-yours is 403. */
async function requireOwnedArtifact(
  artifactId: string,
  viewerRef: string,
): Promise<{ readonly ownerId: string; readonly visibility: Visibility }> {
  const viewer = await resolveViewer(viewerRef)
  const loaded = viewer === null ? null : await loadArtifactForRead(artifactId)

  if (viewer === null || loaded === null || !canRead(viewer, loaded.artifact, loaded.version)) {
    throw new HttpError('NOT_FOUND', 'No such artifact')
  }

  if (writerUserId(viewer) !== loaded.artifact.ownerId) {
    throw new HttpError('FORBIDDEN', 'Only the owner can change this artifact')
  }

  return { ownerId: loaded.artifact.ownerId, visibility: loaded.artifact.visibility }
}

export async function updateArtifact(input: UpdateArtifactInput): Promise<ArtifactView> {
  const current = await requireOwnedArtifact(input.artifactId, input.viewerRef)

  const [row] = await db
    .update(artifacts)
    .set({
      ...(input.patch.title === undefined
        ? {}
        : { title: input.patch.title, slug: slugFromTitle(input.patch.title) }),
      ...(input.patch.visibility === undefined ? {} : { visibility: input.patch.visibility }),
      updatedAt: sql`now()`,
    })
    .where(eq(artifacts.id, input.artifactId))
    .returning({
      id: artifacts.id,
      title: artifacts.title,
      slug: artifacts.slug,
      visibility: artifacts.visibility,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
    })

  if (row === undefined) throw new HttpError('NOT_FOUND', 'No such artifact')

  // Only an actual transition is an event. Re-sending the current value must not manufacture a
  // row that reads as a privacy change in the audit trail.
  if (input.patch.visibility !== undefined && input.patch.visibility !== current.visibility) {
    await recordAuditEvent({
      action: 'artifact.visibility_change',
      actorUserId: current.ownerId,
      actorIp: input.actorIp ?? null,
      artifactId: input.artifactId,
      metadata: { from: current.visibility, to: input.patch.visibility },
    })
  }

  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    viewUrl: artifactViewUrl(row.id),
  }
}

/**
 * The authorization half of delete, which S4 needs so a non-owner's `DELETE` is a 403 rather
 * than a 405. The soft delete itself is all `deleted_at` does today — trash listing, restore,
 * and purge are S9, and `canRead` branch 1 already makes a deleted artifact unreadable.
 */
export async function softDeleteArtifact(input: {
  readonly artifactId: string
  readonly viewerRef: string
  readonly actorIp?: string | null
}): Promise<void> {
  const current = await requireOwnedArtifact(input.artifactId, input.viewerRef)

  await db
    .update(artifacts)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(artifacts.id, input.artifactId))

  await recordAuditEvent({
    action: 'artifact.delete',
    actorUserId: current.ownerId,
    actorIp: input.actorIp ?? null,
    artifactId: input.artifactId,
    metadata: { visibility: current.visibility },
  })
}

/** Re-reads through the gate so the caller sees exactly what a reader would. */
export async function readArtifactView(
  artifactId: string,
  viewerRef: string,
): Promise<ArtifactView | null> {
  const authorized = await authorizeArtifactRead(artifactId, viewerRef)
  if (authorized === null) return null

  const [row] = await db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      slug: artifacts.slug,
      visibility: artifacts.visibility,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .limit(1)

  if (row === undefined) return null

  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    viewUrl: artifactViewUrl(row.id),
  }
}
