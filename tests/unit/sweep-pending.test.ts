import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ObjectStore } from '@/lib/storage/object-store'

/**
 * The sweeper's claim-then-delete ordering, against the SQL drizzle actually renders (the same
 * `pg-proxy` harness as version-ordering.test.ts). The race it guards — an upload flipping to
 * `ready` while its row is being swept — needs two real transactions and lives in
 * tests/integration/sweep-pending.test.ts; this pins the statements and their order.
 */

const harness = vi.hoisted(() => ({
  log: [] as string[],
  responders: [] as ((sql: string) => unknown[][] | undefined)[],
}))

vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const proxy = drizzle((sql) => {
    harness.log.push(sql)
    for (const responder of harness.responders) {
      const rows = responder(sql)
      if (rows !== undefined) return Promise.resolve({ rows })
    }
    return Promise.reject(new Error(`unexpected statement: ${sql}`))
  })

  return {
    db: {
      select: proxy.select.bind(proxy),
      delete: proxy.delete.bind(proxy),
      transaction: (callback: (transaction: typeof proxy) => Promise<unknown>) => callback(proxy),
    },
  }
})

const { sweepPendingVersions } = await import('@/jobs/sweep-pending')

const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555'
const VERSION_ID = '22222222-3333-4444-8555-666666666666'

const SCAN = /^select "id", "artifact_id" from "artifact_versions"/
const CLAIM = /^select "id" from "artifact_versions" .*for update skip locked$/
const DELETE_VERSION = /^delete from "artifact_versions"/
const LOCK_ARTIFACT = /^select "id" from "artifacts" .*for update$/
const REMAINING = /^select "id" from "artifact_versions" where "artifact_versions"\."artifact_id" = \$\d+ limit/
const DELETE_ARTIFACT = /^delete from "artifacts"/

function when(pattern: RegExp, rows: unknown[][]): (sql: string) => unknown[][] | undefined {
  return (sql) => (pattern.test(sql) ? rows : undefined)
}

function label(sql: string): string {
  if (SCAN.test(sql)) return 'scan'
  if (CLAIM.test(sql)) return 'claim'
  if (DELETE_VERSION.test(sql)) return 'delete-version'
  if (LOCK_ARTIFACT.test(sql)) return 'lock-artifact'
  if (REMAINING.test(sql)) return 'remaining'
  if (DELETE_ARTIFACT.test(sql)) return 'delete-artifact'
  return sql
}

function recordingStore(): ObjectStore {
  return {
    ensureBucket: () => Promise.resolve(),
    putObject: () => Promise.resolve(),
    getObject: () => Promise.reject(new Error('not used')),
    getObjectStream: () => Promise.reject(new Error('not used')),
    presignGetUrl: () => Promise.reject(new Error('not used')),
    listKeys: () => Promise.reject(new Error('not used')),
    deletePrefix: () => {
      harness.log.push('delete-objects')
      return Promise.resolve()
    },
  }
}

beforeEach(() => {
  harness.log.length = 0
  harness.responders.length = 0
})

describe('sweepPendingVersions', () => {
  it('claims the row, then deletes objects, the row and the orphaned artifact, in that order', async () => {
    harness.responders.push(
      when(SCAN, [[VERSION_ID, ARTIFACT_ID]]),
      when(CLAIM, [[VERSION_ID]]),
      when(DELETE_VERSION, []),
      when(LOCK_ARTIFACT, [[ARTIFACT_ID]]),
      when(REMAINING, []),
      when(DELETE_ARTIFACT, [[ARTIFACT_ID]]),
    )

    const result = await sweepPendingVersions(recordingStore())

    expect(result).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 1 })
    expect(harness.log.map(label)).toEqual([
      'scan',
      'claim',
      'delete-objects',
      'delete-version',
      'lock-artifact',
      'remaining',
      'delete-artifact',
    ])
  })

  it('re-checks pending and the cutoff when claiming, and skips rows another transaction holds', async () => {
    harness.responders.push(
      when(SCAN, [[VERSION_ID, ARTIFACT_ID]]),
      when(CLAIM, [[VERSION_ID]]),
      when(DELETE_VERSION, []),
      when(LOCK_ARTIFACT, [[ARTIFACT_ID]]),
      when(REMAINING, [['33333333-4444-4555-8666-777777777777']]),
    )

    const result = await sweepPendingVersions(recordingStore())

    expect(result).toEqual({ sweptVersionCount: 1, failedVersionCount: 0, sweptArtifactCount: 0 })
    const claim = harness.log.find((sql) => CLAIM.test(sql))
    expect(claim).toMatch(/"status" = \$\d+/)
    expect(claim).toMatch(/"created_at" < now\(\) - make_interval\(mins => \$\d+\)/)
    expect(harness.log.map(label)).not.toContain('delete-artifact')
  })

  it('leaves the objects and the row alone when the version is no longer claimable', async () => {
    // A flip that holds the row lock (SKIP LOCKED) or has already made it ready: no rows.
    harness.responders.push(when(SCAN, [[VERSION_ID, ARTIFACT_ID]]), when(CLAIM, []))

    const result = await sweepPendingVersions(recordingStore())

    expect(result).toEqual({ sweptVersionCount: 0, failedVersionCount: 0, sweptArtifactCount: 0 })
    expect(harness.log.map(label)).toEqual(['scan', 'claim'])
  })

  it('counts a storage failure as deferred and never deletes the row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    harness.responders.push(when(SCAN, [[VERSION_ID, ARTIFACT_ID]]), when(CLAIM, [[VERSION_ID]]))
    const failingStore: ObjectStore = {
      ...recordingStore(),
      deletePrefix: () => Promise.reject(new Error('storage down')),
    }

    const result = await sweepPendingVersions(failingStore)

    expect(result).toEqual({ sweptVersionCount: 0, failedVersionCount: 1, sweptArtifactCount: 0 })
    expect(harness.log.map(label)).toEqual(['scan', 'claim'])
    vi.restoreAllMocks()
  })
})
