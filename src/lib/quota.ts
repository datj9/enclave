import { and, asc, count, eq, gt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { generations } from '@/db/schema/generations'
import { usageCounters } from '@/db/schema/usage-counters'
import { env } from '@/env'
import { HttpError } from '@/lib/http'
import type { DbHandle } from '@/lib/invites/redeem'

/**
 * The §5.7 generation caps: a rolling hourly rate limit and a fixed daily quota, both per user
 * (US-9 — one user cannot drain the operator's key).
 *
 * Two counters because they answer different questions. The hourly limit counts `generations`
 * rows in the trailing 60 minutes, so a burst decays continuously; the daily quota is a stored
 * counter in `usage_counters`, so it survives a restart and holds across replicas. The in-process
 * limiter in `src/lib/rate-limit.ts` can do neither, which is why it stays on the auth surface.
 *
 * Check and spend are one step (`reserveGeneration`). Checking first and counting later let two
 * concurrent requests both read "one slot left" and both reach the provider, so a burst could run
 * past either cap. A reservation instead takes a per-user advisory lock, reads both counters,
 * and — only if the decision is "allowed" — writes the `generations` row and bumps the daily
 * counter before the lock is released at commit. A second request for the same user waits on the
 * lock and then sees the first one's row and counter.
 *
 * What an attempt costs, precisely:
 *
 *  - denied by either cap: nothing — no `generations` row, no counter bump, no provider call;
 *  - rejected by the provider before its first delta (a bad key, a 429, a refusal, a client that
 *    disconnected first): its `generations` row stays, so it still occupies a slot in the hourly
 *    window — that row is the durable record of the attempt, and the hourly limit has always
 *    counted attempts — but its daily unit is handed back by `releaseGenerationReservation`, so
 *    a rejected key consumes no daily quota;
 *  - anything that reached the model: one hourly slot and one daily unit, whatever happens later
 *    in the stream.
 *
 * If the process dies between the reservation and a refund the daily counter keeps the unit;
 * erring toward over-counting one attempt is the safe side of a spend limit.
 */

/** Distinct from the setup/invite/password-reset lock spaces, so none of them contend. */
const QUOTA_LOCK_NAMESPACE = 8_531_210

const HOUR_SECONDS = 3600
const DAY_SECONDS = 86_400
const MILLIS_PER_SECOND = 1000

export type QuotaDenialCode = 'RATE_LIMITED' | 'QUOTA_EXCEEDED'

export type QuotaDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly code: QuotaDenialCode
      readonly retryAfterSeconds: number
    }

export interface QuotaUsage {
  readonly hourlyCount: number
  readonly hourlyLimit: number
  /** When the oldest generation still inside the hourly window leaves it. */
  readonly hourlySlotFreesAt: Date | undefined
  readonly dailyCount: number
  readonly dailyLimit: number
}

/** UTC so a counter never resets twice, or not at all, when the server's offset changes. */
export function utcWindowDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function secondsUntil(moment: Date, now: Date): number {
  return Math.max(1, Math.ceil((moment.getTime() - now.getTime()) / MILLIS_PER_SECOND))
}

function nextUtcMidnight(now: Date): Date {
  const midnight = new Date(now)
  midnight.setUTCHours(0, 0, 0, 0)
  return new Date(midnight.getTime() + DAY_SECONDS * MILLIS_PER_SECOND)
}

/** Pure, so the n / n+1 boundary is testable without a database. */
export function decideQuota(usage: QuotaUsage, now: Date): QuotaDecision {
  if (usage.hourlyCount >= usage.hourlyLimit) {
    const freesAt =
      usage.hourlySlotFreesAt === undefined
        ? new Date(now.getTime() + HOUR_SECONDS * MILLIS_PER_SECOND)
        : usage.hourlySlotFreesAt
    return { allowed: false, code: 'RATE_LIMITED', retryAfterSeconds: secondsUntil(freesAt, now) }
  }

  if (usage.dailyCount >= usage.dailyLimit) {
    return {
      allowed: false,
      code: 'QUOTA_EXCEEDED',
      retryAfterSeconds: secondsUntil(nextUtcMidnight(now), now),
    }
  }

  return { allowed: true }
}

export function dailyLimitFor(usingOwnKey: boolean): number {
  return usingOwnKey ? env.QUOTA_GENERATIONS_PER_DAY_OWN_KEY : env.QUOTA_GENERATIONS_PER_DAY
}

export function hourlyLimitFor(usingOwnKey: boolean): number {
  return usingOwnKey
    ? env.RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY
    : env.RATE_LIMIT_GENERATIONS_PER_HOUR
}

async function countGenerationsSince(
  handle: DbHandle,
  userId: string,
  since: Date,
): Promise<number> {
  const [row] = await handle
    .select({ total: count() })
    .from(generations)
    .where(and(eq(generations.userId, userId), gt(generations.createdAt, since)))

  return row?.total ?? 0
}

/**
 * The generation whose expiry brings the window back under the limit. With `hourlyCount` rows and
 * a limit of `n`, that is the row at ascending offset `hourlyCount - n` — offset 0 when the user
 * is exactly at the cap, and later when the operator has since lowered the limit.
 */
async function oldestCountedGeneration(
  handle: DbHandle,
  userId: string,
  since: Date,
  offset: number,
): Promise<Date | undefined> {
  const [row] = await handle
    .select({ createdAt: generations.createdAt })
    .from(generations)
    .where(and(eq(generations.userId, userId), gt(generations.createdAt, since)))
    .orderBy(asc(generations.createdAt))
    .offset(Math.max(0, offset))
    .limit(1)

  return row?.createdAt
}

async function readDailyCount(
  handle: DbHandle,
  userId: string,
  windowDate: string,
): Promise<number> {
  const [row] = await handle
    .select({ generations: usageCounters.generations })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.windowDate, windowDate)))

  return row?.generations ?? 0
}

/**
 * `handle` defaults to the pool for the settings page's read-only display; a reservation passes
 * its transaction so every read happens under the lock and on the connection that holds it.
 */
export async function readQuotaUsage(
  userId: string,
  usingOwnKey: boolean,
  now: Date = new Date(),
  handle: DbHandle = db,
): Promise<QuotaUsage> {
  const windowStart = new Date(now.getTime() - HOUR_SECONDS * MILLIS_PER_SECOND)
  const hourlyLimit = hourlyLimitFor(usingOwnKey)
  const hourlyCount = await countGenerationsSince(handle, userId, windowStart)

  const hourlySlotFreesAt =
    hourlyCount < hourlyLimit
      ? undefined
      : await oldestCountedGeneration(handle, userId, windowStart, hourlyCount - hourlyLimit).then(
          (createdAt) =>
            createdAt === undefined
              ? undefined
              : new Date(createdAt.getTime() + HOUR_SECONDS * MILLIS_PER_SECOND),
        )

  return {
    hourlyCount,
    hourlyLimit,
    hourlySlotFreesAt,
    dailyCount: await readDailyCount(handle, userId, utcWindowDate(now)),
    dailyLimit: dailyLimitFor(usingOwnKey),
  }
}

const DENIAL_MESSAGE: Readonly<Record<QuotaDenialCode, (seconds: number) => string>> = {
  RATE_LIMITED: (seconds) => `Rate limit reached, retry in ${seconds}s`,
  QUOTA_EXCEEDED: (seconds) => `Daily generation quota reached, retry in ${seconds}s`,
}

/** The §5.3 error with `Retry-After` for a denied decision. Pure, so the wording is testable. */
export function quotaDenialError(
  decision: Extract<QuotaDecision, { readonly allowed: false }>,
): HttpError {
  return new HttpError(decision.code, DENIAL_MESSAGE[decision.code](decision.retryAfterSeconds), {
    headers: { 'retry-after': String(decision.retryAfterSeconds) },
  })
}

/** What `releaseGenerationReservation` needs to hand back exactly the unit that was taken. */
export interface QuotaReservation {
  readonly userId: string
  /** The UTC day the unit was charged to — a refund after midnight must not credit the new day. */
  readonly windowDate: string
}

export interface ReservedGeneration<TRecord> {
  readonly record: TRecord
  readonly reservation: QuotaReservation
}

/**
 * Atomically checks both caps and, if they allow it, spends one unit of each: `recordAttempt`
 * writes the `generations` row (the hourly unit) on the same transaction, and the daily counter
 * is incremented beside it. Throws the §5.3 `RATE_LIMITED` / `QUOTA_EXCEEDED` error, with nothing
 * written, when either cap is reached.
 *
 * The lock is per user and held only for these few statements — never across the provider call.
 */
export async function reserveGeneration<TRecord>(
  userId: string,
  usingOwnKey: boolean,
  recordAttempt: (handle: DbHandle) => Promise<TRecord>,
  now: Date = new Date(),
): Promise<ReservedGeneration<TRecord>> {
  const windowDate = utcWindowDate(now)

  const record = await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(${QUOTA_LOCK_NAMESPACE}, hashtext(${userId}))`,
    )

    const decision = decideQuota(await readQuotaUsage(userId, usingOwnKey, now, transaction), now)
    if (!decision.allowed) throw quotaDenialError(decision)

    const recorded = await recordAttempt(transaction)

    await transaction
      .insert(usageCounters)
      .values({ userId, windowDate, generations: 1 })
      .onConflictDoUpdate({
        target: [usageCounters.userId, usageCounters.windowDate],
        set: { generations: sql`${usageCounters.generations} + 1` },
      })

    return recorded
  })

  return { record, reservation: { userId, windowDate } }
}

/**
 * Hands back the daily unit of an attempt the provider rejected before producing anything. The
 * hourly unit is not refunded: the attempt's `generations` row stays (see the module comment).
 *
 * Never throws: it runs from the catch block that is about to report the provider's own error,
 * and a failed refund must not replace that error. `greatest` keeps a refund racing a manual
 * counter reset from driving the row negative.
 */
export async function releaseGenerationReservation(reservation: QuotaReservation): Promise<void> {
  try {
    await db
      .update(usageCounters)
      .set({ generations: sql`greatest(${usageCounters.generations} - 1, 0)` })
      .where(
        and(
          eq(usageCounters.userId, reservation.userId),
          eq(usageCounters.windowDate, reservation.windowDate),
        ),
      )
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: 'quota.refund_failed',
        userId: reservation.userId,
        error: String(error),
      }),
    )
  }
}
