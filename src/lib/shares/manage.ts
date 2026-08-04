import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { shareLinks } from '@/db/schema/share-links'
import { requireOwnedArtifact } from '@/lib/artifacts/update'
import { recordAuditEvent } from '@/lib/audit'
import { env } from '@/env'
import { HttpError } from '@/lib/http'
import { databaseNowEpoch, epochToDate } from './clock'
import { loadShareLink } from './links'
import { mintShareToken, shareLinkUrl } from './token'

/**
 * Creating, listing and revoking share links (grill-result §5.3). Owner-only throughout:
 * `requireOwnedArtifact` makes an unreadable artifact a 404 and a readable one that belongs to
 * somebody else a 403, so nothing here confirms an artifact exists to a stranger.
 *
 * The plaintext token exists only inside `createShareLink`'s return value. Nothing else in this
 * module reads `token_hash`, and no summary carries anything derived from it (§8, A.10.1.1).
 */

/** `token` is the one and only time the value is readable. */
export interface CreatedShareLink {
  readonly shareId: string
  readonly token: string
  readonly url: string
}

export interface ShareLinkSummary {
  readonly shareId: string
  readonly versionId: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
  readonly viewCount: number
  readonly lastViewedAt: string | null
  readonly createdAt: string
}

/** `databaseNow` is Postgres `now()`, Z-suffixed, so a client can judge STATE without guessing. */
export interface ShareLinkListResult {
  readonly items: readonly ShareLinkSummary[]
  readonly databaseNow: string
}

export interface CreateShareLinkInput {
  readonly artifactId: string
  readonly versionId: string
  readonly viewerRef: string
  readonly expiresAt?: Date | null
  readonly actorIp?: string | null
}

/**
 * The version to pin, plus the database's clock in the same round trip. A link may only pin a
 * `ready` version of this artifact — pinning someone else's version id would hand out a capability
 * to an artifact its owner never shared.
 */
async function loadPinnableVersion(
  artifactId: string,
  versionId: string,
): Promise<{ readonly versionId: string; readonly databaseNow: Date }> {
  const [row] = await db
    .select({ id: artifactVersions.id, databaseNow: databaseNowEpoch })
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.id, versionId),
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.status, 'ready'),
      ),
    )
    .limit(1)

  if (row === undefined) {
    throw new HttpError('VALIDATION_FAILED', 'That version does not belong to this artifact', {
      details: { fields: ['versionId'] },
    })
  }

  return { versionId: row.id, databaseNow: epochToDate(row.databaseNow) }
}

export async function createShareLink(input: CreateShareLinkInput): Promise<CreatedShareLink> {
  const owned = await requireOwnedArtifact(input.artifactId, input.viewerRef)
  const version = await loadPinnableVersion(input.artifactId, input.versionId)
  const expiresAt = input.expiresAt ?? null

  // Compared against Postgres `now()` rather than `Date.now()`, like every other expiry check in
  // the product (§7). A link created already expired would be dead on arrival.
  if (expiresAt !== null && expiresAt <= version.databaseNow) {
    throw new HttpError('VALIDATION_FAILED', 'expiresAt must be in the future', {
      details: { fields: ['expiresAt'] },
    })
  }

  const { plaintext, tokenHash } = mintShareToken()

  const [row] = await db
    .insert(shareLinks)
    .values({
      artifactId: input.artifactId,
      versionId: version.versionId,
      tokenHash,
      createdBy: owned.ownerId,
      expiresAt,
    })
    .returning({ id: shareLinks.id })

  if (row === undefined) throw new HttpError('INTERNAL_ERROR', 'Could not create the share link')

  await recordAuditEvent({
    action: 'share.create',
    actorUserId: owned.ownerId,
    actorIp: input.actorIp ?? null,
    artifactId: input.artifactId,
    versionId: version.versionId,
    shareLinkId: row.id,
    metadata: { expiresAt: expiresAt === null ? null : expiresAt.toISOString() },
  })

  return {
    shareId: row.id,
    token: plaintext,
    url: shareLinkUrl(env.APP_URL, plaintext),
  }
}

/** A row-less fallback for the empty list, where the main query below carries no clock reading. */
async function readDatabaseNow(): Promise<Date> {
  const [row] = await db.execute<{ databaseNow: string | number }>(
    sql`select ${databaseNowEpoch} as "databaseNow"`,
  )
  if (row === undefined) throw new HttpError('INTERNAL_ERROR', 'Could not read the database clock')
  return epochToDate(row.databaseNow)
}

/**
 * Never selects `token_hash`: the list must not expose anything derived from the secret.
 *
 * Carries Postgres `now()` alongside the rows so a client can judge expiry without trusting its
 * own clock (§7), the same way `createShareLink` already does.
 */
export async function listShareLinks(
  artifactId: string,
  viewerRef: string,
): Promise<ShareLinkListResult> {
  await requireOwnedArtifact(artifactId, viewerRef)

  const rows = await db
    .select({
      id: shareLinks.id,
      versionId: shareLinks.versionId,
      expiresAt: shareLinks.expiresAt,
      revokedAt: shareLinks.revokedAt,
      viewCount: shareLinks.viewCount,
      lastViewedAt: shareLinks.lastViewedAt,
      createdAt: shareLinks.createdAt,
      databaseNow: databaseNowEpoch,
    })
    .from(shareLinks)
    .where(eq(shareLinks.artifactId, artifactId))
    .orderBy(desc(shareLinks.createdAt))

  const [firstRow] = rows
  const databaseNow = (
    firstRow === undefined ? await readDatabaseNow() : epochToDate(firstRow.databaseNow)
  ).toISOString()

  return {
    items: rows.map((row) => ({
      shareId: row.id,
      versionId: row.versionId,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      viewCount: row.viewCount,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    databaseNow,
  }
}

export interface ShareableVersion {
  readonly versionId: string
  readonly versionNo: number
  readonly isCurrent: boolean
}

/**
 * The versions a link may pin, newest first — what the share dialog offers. `ready` only, for the
 * same reason `createShareLink` refuses anything else: a pending version has nothing to serve.
 */
export async function listShareableVersions(
  artifactId: string,
  viewerRef: string,
): Promise<readonly ShareableVersion[]> {
  await requireOwnedArtifact(artifactId, viewerRef)

  const rows = await db
    .select({
      id: artifactVersions.id,
      versionNo: artifactVersions.versionNo,
      currentVersionId: artifacts.currentVersionId,
    })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.status, 'ready')))
    .orderBy(desc(artifactVersions.versionNo))

  return rows.map((row) => ({
    versionId: row.id,
    versionNo: row.versionNo,
    isCurrent: row.currentVersionId === row.id,
  }))
}

/**
 * Idempotent: revoking an already-revoked link keeps the first timestamp and writes no second
 * audit row, so a double-clicked button does not look like two separate revocations.
 */
export async function revokeShareLink(
  shareId: string,
  viewerRef: string,
  actorIp?: string | null,
): Promise<void> {
  const resolved = await loadShareLink(shareId)
  if (resolved === null) throw new HttpError('NOT_FOUND', 'No such share link')

  const owned = await requireOwnedArtifact(resolved.link.artifactId, viewerRef)

  const revoked = await db
    .update(shareLinks)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(shareLinks.id, shareId), isNull(shareLinks.revokedAt)))
    .returning({ id: shareLinks.id })

  if (revoked.length === 0) return

  await recordAuditEvent({
    action: 'share.revoke',
    actorUserId: owned.ownerId,
    actorIp: actorIp ?? null,
    artifactId: resolved.link.artifactId,
    versionId: resolved.link.versionId,
    shareLinkId: shareId,
  })
}
