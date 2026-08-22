import { bigserial, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * The A.12.4.1 audit trail, per grill-result §5.2. Append-only: the app role gets INSERT and
 * SELECT, and `AUDIT_LOG_APPEND_ONLY_DDL` (src/db/audit-log-guard.ts) refuses every UPDATE and
 * every DELETE that is not the retention job.
 *
 * Deliberately no foreign keys. §5.2 lists these columns as bare uuids, and an audit row has to
 * outlive the artifact, version, share link, token, and user it refers to — a cascade or a
 * restrict from any of those would either erase history or block a legitimate purge.
 */

export const AUDIT_ACTIONS = [
  'artifact.create',
  'artifact.visibility_change',
  'artifact.delete',
  'artifact.restore',
  'artifact.purge',
  'artifact.tag_change',
  'version.create',
  'share.create',
  'share.revoke',
  'share.expire',
  'artifact.view',
  'user.invite',
  'user.create',
  'user.deactivate',
  'token.create',
  'token.revoke',
  'auth.login',
  'auth.login_failed',
  'category.create',
  'category.update',
  'settings.update',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditMetadata = Record<string, unknown>

export const auditLog = pgTable(
  'audit_log',
  {
    // `number` rather than `bigint`: the value is read back by the S10 audit viewer and JSON
    // cannot serialise a BigInt. 2^53 rows is far beyond the retention window.
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
    actorUserId: uuid('actor_user_id'),
    actorTokenId: uuid('actor_token_id'),
    actorShareLinkId: uuid('actor_share_link_id'),
    actorIp: inet('actor_ip'),
    artifactId: uuid('artifact_id'),
    versionId: uuid('version_id'),
    shareLinkId: uuid('share_link_id'),
    metadata: jsonb('metadata').$type<AuditMetadata>(),
  },
  (table) => [
    // The retention job's only predicate, and the admin viewer's default order.
    index('audit_log_at_idx').on(table.at.desc()),
    index('audit_log_artifact_at_idx').on(table.artifactId, table.at.desc()),
    index('audit_log_actor_at_idx').on(table.actorUserId, table.at.desc()),
  ],
)

export type AuditLogRow = typeof auditLog.$inferSelect
export type NewAuditLogRow = typeof auditLog.$inferInsert
