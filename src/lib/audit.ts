/**
 * Audit-shaped structured logging. S4 adds the `audit_log` table and will write these same
 * events to Postgres; until then they go to stdout in the shape the table will hold, so the
 * action names and field names do not have to change when the table arrives.
 *
 * Never pass prompt text, tokens, presigned URLs, or Authorization headers (§8 log hygiene).
 */

export type AuditAction =
  | 'artifact.create'
  | 'artifact.visibility_change'
  | 'artifact.delete'
  | 'artifact.restore'
  | 'artifact.purge'
  | 'version.create'
  | 'share.create'
  | 'share.revoke'
  | 'share.expire'
  | 'artifact.view'
  | 'user.invite'
  | 'user.create'
  | 'user.deactivate'
  | 'token.create'
  | 'token.revoke'
  | 'auth.login'
  | 'auth.login_failed'

export interface AuditEvent {
  readonly action: AuditAction
  readonly actorUserId?: string | null
  readonly actorIp?: string | null
  readonly artifactId?: string | null
  readonly versionId?: string | null
  readonly shareLinkId?: string | null
  readonly metadata?: Record<string, unknown>
}

export function recordAuditEvent(event: AuditEvent): void {
  console.info(JSON.stringify({ at: new Date().toISOString(), kind: 'audit', ...event }))
}
