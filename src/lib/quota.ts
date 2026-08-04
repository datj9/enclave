import { and, asc, count, eq, gt, sql } from 'drizzle-orm'

import { db } from '@/db'
import { generations } from '@/db/schema/generations'
import { usageCounters } from '@/db/schema/usage-counters'
import { env } from '@/env'
import { HttpError } from '@/lib/http'

/**
 * The §5.7 generation caps: a rolling hourly rate limit and a fixed daily quota, both per user
 * (US-9 — one user cannot drain the operator's key).
 *
 * Two counters because they answer different questions. The hourly limit counts `generations`
 * rows in the trailing 60 minutes, so a burst decays continuously; the daily quota is a stored
 * counter in `usage_counters`, so it survives a restart and holds across replicas. The in-process
 * limiter in `src/lib/rate-limit.ts` can do neither, which is why it stays on the auth surface.
 *
 * Both are checked before the provider is called and neither is incremented by a rejected call:
 * `recordGeneration` runs only once a stream has actually opened.
 */

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

async function countGenerationsSince(userId: string, since: Date): Promise<number> {
  const [row] = await db
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
  userId: string,
  since: Date,
  offset: number,
): Promise<Date | undefined> {
  const [row] = await db
    .select({ createdAt: generations.createdAt })
    .from(generations)
    .where(and(eq(generations.userId, userId), gt(generations.createdAt, since)))
    .orderBy(asc(generations.createdAt))
    .offset(Math.max(0, offset))
    .limit(1)

  return row?.createdAt
}

async function readDailyCount(userId: string, windowDate: string): Promise<number> {
  const [row] = await db
    .select({ generations: usageCounters.generations })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.windowDate, windowDate)))

  return row?.generations ?? 0
}

export async function readQuotaUsage(
  userId: string,
  usingOwnKey: boolean,
  now: Date = new Date(),
): Promise<QuotaUsage> {
  const windowStart = new Date(now.getTime() - HOUR_SECONDS * MILLIS_PER_SECOND)
  const hourlyLimit = hourlyLimitFor(usingOwnKey)
  const hourlyCount = await countGenerationsSince(userId, windowStart)

  const hourlySlotFreesAt =
    hourlyCount < hourlyLimit
      ? undefined
      : await oldestCountedGeneration(userId, windowStart, hourlyCount - hourlyLimit).then(
          (createdAt) =>
            createdAt === undefined
              ? undefined
              : new Date(createdAt.getTime() + HOUR_SECONDS * MILLIS_PER_SECOND),
        )

  return {
    hourlyCount,
    hourlyLimit,
    hourlySlotFreesAt,
    dailyCount: await readDailyCount(userId, utcWindowDate(now)),
    dailyLimit: dailyLimitFor(usingOwnKey),
  }
}

export async function checkQuota(userId: string, usingOwnKey: boolean): Promise<QuotaDecision> {
  const now = new Date()
  return decideQuota(await readQuotaUsage(userId, usingOwnKey, now), now)
}

const DENIAL_MESSAGE: Readonly<Record<QuotaDenialCode, (seconds: number) => string>> = {
  RATE_LIMITED: (seconds) => `Rate limit reached, retry in ${seconds}s`,
  QUOTA_EXCEEDED: (seconds) => `Daily generation quota reached, retry in ${seconds}s`,
}

/** Throws the §5.3 error with `Retry-After` when the user is over either cap. */
export async function enforceQuota(userId: string, usingOwnKey: boolean): Promise<void> {
  const decision = await checkQuota(userId, usingOwnKey)
  if (decision.allowed) return

  throw new HttpError(decision.code, DENIAL_MESSAGE[decision.code](decision.retryAfterSeconds), {
    headers: { 'retry-after': String(decision.retryAfterSeconds) },
  })
}

/** Called only after a provider stream has opened, so a rejected request consumes no quota. */
export async function recordGeneration(userId: string, now: Date = new Date()): Promise<void> {
  await db
    .insert(usageCounters)
    .values({ userId, windowDate: utcWindowDate(now), generations: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.windowDate],
      set: { generations: sql`${usageCounters.generations} + 1` },
    })
}
