import { z } from 'zod'

/**
 * Shared write-side contract for optional `expiresAt` bodies (shares + tokens).
 * Zod's `z.iso.datetime({ offset: true })` only accepts uppercase `Z`; RFC 3339 §5.6 also
 * permits lowercase `z`, which the CLI and audit filter already accept. Normalise trailing `z`
 * so the three surfaces agree and the error message can honestly claim RFC 3339.
 */
export const EXPIRES_AT_REASON =
  'expiresAt must be an RFC 3339 instant with an explicit zone, e.g. 2026-08-10T23:59:00+07:00 or 2026-08-10T16:59:00Z'

export const optionalExpiresAtSchema = z.preprocess((value) => {
  if (typeof value === 'string' && value.endsWith('z')) return `${value.slice(0, -1)}Z`
  return value
}, z.iso.datetime({ offset: true, error: EXPIRES_AT_REASON })).optional()
