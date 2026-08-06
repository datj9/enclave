import { sql } from 'drizzle-orm'

/**
 * §7 clock skew: every expiry comparison in the product is against the database's clock, never
 * `Date.now()`. This is how that clock is read.
 *
 * An epoch rather than the timestamp itself, because a bare `now()` arrives as text the driver
 * does not parse — `2026-08-01 09:47:04.239368+00`, with a space where ISO 8601 wants a `T` and a
 * two-digit offset — and `new Date()` accepting that shape is luck, not a contract. A number has
 * exactly one reading.
 */

export const databaseNowEpoch = sql<string | number>`extract(epoch from now())`

export function epochToDate(epochSeconds: string | number): Date {
  return new Date(Number(epochSeconds) * 1000)
}

/**
 * Single-row clock conversion. Returns `null` when the row is missing so callers can fail closed
 * with their own error type (HttpError vs test Error) rather than falling open.
 */
export function tryEpochToDate(
  row: { readonly databaseNow: string | number } | undefined,
): Date | null {
  return row === undefined ? null : epochToDate(row.databaseNow)
}
