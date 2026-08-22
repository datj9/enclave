/**
 * Decides whether a session cookie issued before a password change is still valid. Extracted from
 * `src/lib/auth/session.ts` so the comparison is unit-tested; `session.ts` stays in the vitest
 * coverage exclude list because it talks to `next/headers` and Postgres.
 */

export function isSessionInvalidatedByPasswordChange(
  passwordChangedAt: Date | null,
  issuedAtSeconds: number | undefined,
): boolean {
  if (passwordChangedAt === null) return false
  if (typeof issuedAtSeconds !== 'number' || !Number.isFinite(issuedAtSeconds)) return true
  return Math.floor(passwordChangedAt.getTime() / 1000) > issuedAtSeconds
}
