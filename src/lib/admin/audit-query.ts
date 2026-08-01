import { AUDIT_ACTIONS, type AuditAction } from '@/db/schema/audit-log'

/**
 * `GET /api/v1/audit?action=&actorUserId=&artifactId=&from=&to=&cursor=` parsing. Pure, so every
 * boundary — a bogus action, a reversed date range, a tampered cursor — is unit-testable without
 * Postgres.
 *
 * The cursor is a keyset position on `(at, id)`, not an offset: an event written while the admin
 * pages cannot shift rows onto a page they already read.
 */

export const DEFAULT_AUDIT_LIMIT = 50
export const MAX_AUDIT_LIMIT = 200

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURSOR_SEPARATOR = '|'

export interface AuditCursor {
  readonly at: string
  readonly id: number
}

export interface AuditFilter {
  readonly action: AuditAction | undefined
  readonly actorUserId: string | undefined
  readonly artifactId: string | undefined
  readonly from: Date | undefined
  readonly to: Date | undefined
  readonly limit: number
  readonly cursor: AuditCursor | undefined
}

export type AuditFilterParse =
  | { readonly ok: true; readonly value: AuditFilter }
  | { readonly ok: false; readonly details: Record<string, unknown> }

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.at}${CURSOR_SEPARATOR}${cursor.id}`, 'utf8').toString('base64url')
}

export function decodeAuditCursor(rawCursor: string): AuditCursor | undefined {
  const decoded = Buffer.from(rawCursor, 'base64url').toString('utf8')
  const separatorIndex = decoded.indexOf(CURSOR_SEPARATOR)
  if (separatorIndex === -1) return undefined

  const at = decoded.slice(0, separatorIndex)
  const id = Number(decoded.slice(separatorIndex + 1))
  if (Number.isNaN(Date.parse(at))) return undefined
  if (!Number.isSafeInteger(id) || id < 0) return undefined

  return { at, id }
}

function optionalParameter(searchParams: URLSearchParams, name: string): string | undefined {
  const value = searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

function parseLimit(rawLimit: string | undefined): number | undefined {
  if (rawLimit === undefined) return DEFAULT_AUDIT_LIMIT
  if (!/^\d+$/.test(rawLimit)) return undefined

  const limit = Number(rawLimit)
  return limit < 1 || limit > MAX_AUDIT_LIMIT ? undefined : limit
}

function parseMoment(rawMoment: string | undefined): Date | undefined | 'invalid' {
  if (rawMoment === undefined) return undefined
  const parsed = Date.parse(rawMoment)
  return Number.isNaN(parsed) ? 'invalid' : new Date(parsed)
}

function isAuditAction(candidate: string): candidate is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(candidate)
}

function rejected(parameter: string): AuditFilterParse {
  return { ok: false, details: { parameter } }
}

export function parseAuditFilter(searchParams: URLSearchParams): AuditFilterParse {
  const limit = parseLimit(optionalParameter(searchParams, 'limit'))
  if (limit === undefined) return { ok: false, details: { parameter: 'limit', max: MAX_AUDIT_LIMIT } }

  const rawAction = optionalParameter(searchParams, 'action')
  if (rawAction !== undefined && !isAuditAction(rawAction)) return rejected('action')

  const actorUserId = optionalParameter(searchParams, 'actorUserId')
  if (actorUserId !== undefined && !UUID_PATTERN.test(actorUserId)) return rejected('actorUserId')

  const artifactId = optionalParameter(searchParams, 'artifactId')
  if (artifactId !== undefined && !UUID_PATTERN.test(artifactId)) return rejected('artifactId')

  const from = parseMoment(optionalParameter(searchParams, 'from'))
  if (from === 'invalid') return rejected('from')
  const to = parseMoment(optionalParameter(searchParams, 'to'))
  if (to === 'invalid') return rejected('to')
  if (from !== undefined && to !== undefined && to < from) return rejected('to')

  const rawCursor = optionalParameter(searchParams, 'cursor')
  const cursor = rawCursor === undefined ? undefined : decodeAuditCursor(rawCursor)
  if (rawCursor !== undefined && cursor === undefined) return rejected('cursor')

  return {
    ok: true,
    value: {
      action: rawAction === undefined ? undefined : rawAction,
      actorUserId,
      artifactId,
      from,
      to,
      limit,
      cursor,
    },
  }
}
