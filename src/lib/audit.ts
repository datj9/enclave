import { isIP } from 'node:net'

import { db } from '@/db'
import { auditLog, type AuditAction, type AuditMetadata } from '@/db/schema/audit-log'

/**
 * The A.12.4.1 audit trail. S4 gave this shim its table; the action names and field names are
 * unchanged from the stdout-only version, so no caller had to move.
 *
 * Never pass prompt text, tokens, presigned URLs, or Authorization headers (§8 log hygiene).
 * `sanitizeMetadata` is the backstop, not the contract — it redacts what slips through.
 */

export type { AuditAction }
export { AUDIT_ACTIONS } from '@/db/schema/audit-log'

export interface AuditEvent {
  readonly action: AuditAction
  readonly actorUserId?: string | null
  readonly actorTokenId?: string | null
  readonly actorShareLinkId?: string | null
  readonly actorIp?: string | null
  readonly artifactId?: string | null
  readonly versionId?: string | null
  readonly shareLinkId?: string | null
  readonly metadata?: AuditMetadata
}

export const REDACTED = '[redacted]'

/**
 * Substring match, so `prompt`, `userPrompt`, and `prompt_text` are all caught. `token` is
 * deliberately absent: `token.create` records a `tokenId`, which is an identifier, not a secret.
 */
const FORBIDDEN_KEY_FRAGMENTS: readonly string[] = [
  'prompt',
  'password',
  'secret',
  'apikey',
  'api_key',
  'authorization',
  'presign',
  'signedurl',
  'signed_url',
]

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'token',
  'plaintext',
  'credential',
  'credentials',
  'messages',
  'completion',
  'content',
])

function isForbiddenKey(key: string): boolean {
  const normalized = key.toLowerCase()
  if (FORBIDDEN_KEYS.has(normalized)) return true
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

/** Exported for the test that proves a prompt cannot reach the table by any key spelling. */
export function sanitizeMetadata(metadata: AuditMetadata | undefined): AuditMetadata | null {
  if (metadata === undefined) return null

  const entries = Object.entries(metadata).map(([key, value]): readonly [string, unknown] => {
    if (isForbiddenKey(key)) return [key, REDACTED]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return [key, sanitizeMetadata(value as AuditMetadata)]
    }
    return [key, value]
  })

  return Object.fromEntries(entries)
}

/**
 * `inet` rejects anything that is not an address, and `clientIpFromHeaders` yields the literal
 * string `unknown` when no forwarding header is present — which would fail the insert.
 */
export function normalizeActorIp(actorIp: string | null | undefined): string | null {
  if (actorIp === null || actorIp === undefined) return null
  const withoutBrackets = actorIp.trim().replace(/^\[(.+)]$/, '$1')
  return isIP(withoutBrackets) === 0 ? null : withoutBrackets
}

/**
 * Resolves once the row is committed, and never rejects: an audit write must not turn a
 * successful read into a 500. A failed insert falls back to stderr so the event still reaches
 * whatever ships the container logs.
 */
export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  const row = {
    action: event.action,
    actorUserId: event.actorUserId ?? null,
    actorTokenId: event.actorTokenId ?? null,
    actorShareLinkId: event.actorShareLinkId ?? null,
    actorIp: normalizeActorIp(event.actorIp),
    artifactId: event.artifactId ?? null,
    versionId: event.versionId ?? null,
    shareLinkId: event.shareLinkId ?? null,
    metadata: sanitizeMetadata(event.metadata),
  }

  try {
    await db.insert(auditLog).values(row)
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown error'
    console.error(
      `[enclave] audit insert failed (${reason})`,
      JSON.stringify({ at: new Date().toISOString(), kind: 'audit', ...row }),
    )
  }
}
