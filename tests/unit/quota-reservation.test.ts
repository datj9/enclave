import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The reservation half of §5.7 with the driver replaced by a recording fake, so the ordering that
 * makes the check-and-spend atomic is pinned without Postgres: the lock first, every read on the
 * transaction, the attempt row and the daily counter only after an "allowed" decision, and
 * nothing written at all on a denial. Concurrency against a real database is covered by
 * tests/integration/generation-quota.test.ts.
 */

type Step = readonly [string, ...unknown[]]

const fake = vi.hoisted(() => {
  const steps: Step[] = []
  const selectResults: unknown[][] = []
  const state = { updateFails: false }

  /** Every builder method returns the chain; awaiting it yields `result`. */
  function chain(result: () => unknown, label: string): unknown {
    const target = {
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve().then(result).then(resolve, reject),
    }
    const proxy: unknown = new Proxy(target, {
      get: (object, property) => {
        if (property === 'then') return object.then
        return (...args: unknown[]) => {
          steps.push([`${label}.${String(property)}`, ...args])
          return proxy
        }
      },
    })
    return proxy
  }

  const transaction = {
    execute: (query: unknown) => {
      steps.push(['tx.execute', query])
      return Promise.resolve()
    },
    select: () => {
      steps.push(['tx.select'])
      return chain(() => selectResults.shift() ?? [], 'tx.select')
    },
    insert: (table: unknown) => {
      steps.push(['tx.insert', table])
      return chain(() => undefined, 'tx.insert')
    },
  }

  const db = {
    transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => {
      steps.push(['db.transaction'])
      const value = await callback(transaction)
      steps.push(['db.commit'])
      return value
    },
    select: () => {
      throw new Error('a reservation must read on its transaction, not the pool')
    },
    insert: () => {
      throw new Error('a reservation must write on its transaction, not the pool')
    },
    update: (table: unknown) => {
      steps.push(['db.update', table])
      return chain(() => {
        if (state.updateFails) throw new Error('connection reset')
        return undefined
      }, 'db.update')
    },
  }

  return { steps, selectResults, state, transaction, db }
})

vi.mock('@/db', () => ({ db: fake.db }))

const { HttpError } = await import('@/lib/http')
const { usageCounters } = await import('@/db/schema/usage-counters')
const {
  hourlyLimitFor,
  dailyLimitFor,
  quotaDenialError,
  releaseGenerationReservation,
  reserveGeneration,
} = await import('@/lib/quota')

const USER_ID = '7f3e0000-0000-4000-8000-0000000000aa'
const NOW = new Date('2026-08-01T23:59:30.000Z')

function stepNames(): string[] {
  return fake.steps.map(([name]) => name)
}

beforeEach(() => {
  fake.steps.length = 0
  fake.selectResults.length = 0
  fake.state.updateFails = false
  vi.restoreAllMocks()
})

describe('reserveGeneration', () => {
  it('locks, reads, records the attempt and bumps the daily counter — in that order', async () => {
    // hourly count, then daily count: both under their caps.
    fake.selectResults.push([{ total: 0 }], [{ generations: 0 }])
    const recordAttempt = vi.fn((handle: unknown) => {
      fake.steps.push(['recordAttempt', handle])
      return Promise.resolve('generation-1')
    })

    const reserved = await reserveGeneration(USER_ID, false, recordAttempt, NOW)

    expect(reserved).toEqual({
      record: 'generation-1',
      reservation: { userId: USER_ID, windowDate: '2026-08-01' },
    })
    expect(recordAttempt).toHaveBeenCalledWith(fake.transaction)

    const names = stepNames()
    expect(names[0]).toBe('db.transaction')
    expect(names[1]).toBe('tx.execute')
    expect(names.indexOf('recordAttempt')).toBeGreaterThan(names.lastIndexOf('tx.select'))
    expect(names.indexOf('tx.insert')).toBeGreaterThan(names.indexOf('recordAttempt'))
    expect(names.at(-1)).toBe('db.commit')
    expect(fake.steps.find(([name]) => name === 'tx.insert')?.[1]).toBe(usageCounters)
  })

  it('denies at the hourly cap with RATE_LIMITED and writes nothing', async () => {
    const limit = hourlyLimitFor(false)
    const oldest = new Date(NOW.getTime() - 20 * 60 * 1000)
    fake.selectResults.push([{ total: limit }], [{ createdAt: oldest }], [{ generations: 0 }])
    const recordAttempt = vi.fn(() => Promise.resolve('never'))

    const error = await reserveGeneration(USER_ID, false, recordAttempt, NOW).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    // The oldest counted row leaves the window 40 minutes from now.
    expect((error as InstanceType<typeof HttpError>).headers).toMatchObject({
      'retry-after': String(40 * 60),
    })
    expect(recordAttempt).not.toHaveBeenCalled()
    expect(stepNames()).not.toContain('tx.insert')
    expect(stepNames()).not.toContain('db.commit')
  })

  it('denies at the daily cap with QUOTA_EXCEEDED and writes nothing', async () => {
    fake.selectResults.push([{ total: 0 }], [{ generations: dailyLimitFor(true) }])
    const recordAttempt = vi.fn(() => Promise.resolve('never'))

    const error = await reserveGeneration(USER_ID, true, recordAttempt, NOW).catch(
      (thrown: unknown) => thrown,
    )

    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 })
    expect(recordAttempt).not.toHaveBeenCalled()
    expect(stepNames()).not.toContain('tx.insert')
  })

  it('bumps no counter when recording the attempt fails, so the transaction rolls back whole', async () => {
    fake.selectResults.push([{ total: 0 }], [{ generations: 0 }])

    await expect(
      reserveGeneration(USER_ID, false, () => Promise.reject(new Error('insert failed')), NOW),
    ).rejects.toThrow('insert failed')
    expect(stepNames()).not.toContain('tx.insert')
    expect(stepNames()).not.toContain('db.commit')
  })
})

describe('releaseGenerationReservation', () => {
  it('decrements the counter of the day the unit was charged to', async () => {
    await releaseGenerationReservation({ userId: USER_ID, windowDate: '2026-08-01' })

    expect(fake.steps[0]).toEqual(['db.update', usageCounters])
    expect(stepNames()).toContain('db.update.set')
    expect(stepNames()).toContain('db.update.where')
  })

  it('never throws, so the provider error it runs beside is the one reported', async () => {
    fake.state.updateFails = true
    const logged: string[] = []
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })

    await expect(
      releaseGenerationReservation({ userId: USER_ID, windowDate: '2026-08-01' }),
    ).resolves.toBeUndefined()
    expect(logged.some((line) => line.includes('quota.refund_failed'))).toBe(true)
  })
})

describe('quotaDenialError', () => {
  it('carries the code, the 429 status and a Retry-After header', () => {
    const error = quotaDenialError({
      allowed: false,
      code: 'QUOTA_EXCEEDED',
      retryAfterSeconds: 30,
    })

    expect(error).toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 })
    expect(error.message).toBe('Daily generation quota reached, retry in 30s')
    expect(error.headers).toMatchObject({ 'retry-after': '30' })
  })
})
