import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/db'
import { VISIBILITIES, artifacts, type Visibility } from '@/db/schema/artifacts'
import { shareLinks } from '@/db/schema/share-links'
import { env } from '@/env'
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

/**
 * Every owner-only write shares this: unreadable is 404, readable-but-not-yours is 403. Exported
 * for the share routes (S5), which are owner-only for exactly the same reason.
 */
export async function requireOwnedArtifact(
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
 * `DELETE /api/v1/artifacts/{id}` (§5.3). One transaction stamps `deleted_at` and revokes every
 * link that was still live, so there is no instant in which the artifact is in the trash while a
 * share URL still opens it. `canRead` branch 1 does the rest: the artifact leaves every read path,
 * the owner's included.
 *
 * A second `DELETE` is a 404 rather than a no-op — `requireOwnedArtifact` reads through the gate,
 * and a trashed artifact is unreadable there.
 */
export async function softDeleteArtifact(input: {
  readonly artifactId: string
  readonly viewerRef: string
  readonly actorIp?: string | null
}): Promise<void> {
  const current = await requireOwnedArtifact(input.artifactId, input.viewerRef)

  const revoked = await db.transaction(async (transaction) => {
    await transaction
      .update(artifacts)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(artifacts.id, input.artifactId))

    return await transaction
      .update(shareLinks)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(shareLinks.artifactId, input.artifactId), isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id })
  })

  await recordAuditEvent({
    action: 'artifact.delete',
    actorUserId: current.ownerId,
    actorIp: input.actorIp ?? null,
    artifactId: input.artifactId,
    metadata: { visibility: current.visibility, revokedShareLinks: revoked.length },
  })
}

/**
 * `POST /api/v1/artifacts/{id}/restore` (§5.3). The gate cannot authorize this one: branch 1
 * refuses a trashed artifact to every viewer, so ownership is checked against the row instead.
 * Everything that is not the active owner — another member, an admin (branch 5), an artifact that
 * was never deleted, one past its retention window — collapses to the same 404.
 */
export async function restoreArtifact(input: {
  readonly artifactId: string
  readonly viewerRef: string
  readonly actorIp?: string | null
  readonly retentionDays?: number
}): Promise<ArtifactView> {
  const viewer = await resolveViewer(input.viewerRef)
  const restorerId = viewer === null ? null : writerUserId(viewer)
  if (restorerId === null) throw new HttpError('NOT_FOUND', 'No such artifact')

  const retentionDays = input.retentionDays ?? env.TRASH_RETENTION_DAYS

  const [row] = await db
    .update(artifacts)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.ownerId, restorerId),
        // Restorable for exactly as long as it is not yet purgeable, on the database clock (§7).
        // `hours`, not `days`: `days` is a calendar field on a timestamptz and drifts across a
        // DST transition (TASK-6) — this must stay textually identical to the purge predicate in
        // src/jobs/purge-trash.ts apart from `gte` vs `lt`, so the restore window closes exactly
        // when purge opens.
        gte(artifacts.deletedAt, sql`now() - make_interval(hours => ${retentionDays * 24})`),
      ),
    )
    .returning({
      id: artifacts.id,
      title: artifacts.title,
      slug: artifacts.slug,
      visibility: artifacts.visibility,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
    })

  if (row === undefined) throw new HttpError('NOT_FOUND', 'No such artifact')

  // Share links stay revoked. Deleting an artifact is what the author reached for to kill the
  // links; silently reviving URLs they believed dead would be the worse surprise.
  await recordAuditEvent({
    action: 'artifact.restore',
    actorUserId: restorerId,
    actorIp: input.actorIp ?? null,
    artifactId: input.artifactId,
    metadata: { retentionDays },
  })

  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    viewUrl: artifactViewUrl(row.id),
  }
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
