import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BundleFile } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'
import type { ObjectStore } from '@/lib/storage/object-store'

/**
 * `markVersionReady` and the `appendVersion` guard, against the SQL drizzle actually renders.
 *
 * Postgres is replaced by drizzle's `pg-proxy` driver: every statement reaches the proxy callback as text
 * plus parameters, and the test answers with canned rows. That keeps the real query builder in
 * the loop — the guards under test live in WHERE clauses, so a hand-rolled chain mock would only
 * prove the mock. `pg-proxy` has no transactions, so `db.transaction` just runs the callback on
 * the same handle; atomicity is covered by the integration suite, ordering logic here.
 */

interface Statement {
  readonly sql: string
  readonly params: readonly unknown[]
}

type Responder = (statement: Statement) => unknown[][] | undefined

const harness = vi.hoisted(() => ({
  statements: [] as { sql: string; params: unknown[] }[],
  responders: [] as ((statement: { sql: string; params: unknown[] }) => unknown[][] | undefined)[],
}))

vi.mock('@/db', async () => {
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const proxy = drizzle((sql, params) => {
    const statement = { sql, params }
    harness.statements.push(statement)
    for (const responder of harness.responders) {
      const rows = responder(statement)
      if (rows !== undefined) return Promise.resolve({ rows })
    }
    return Promise.reject(new Error(`unexpected statement: ${sql}`))
  })

  return {
    db: {
      select: proxy.select.bind(proxy),
      insert: proxy.insert.bind(proxy),
      update: proxy.update.bind(proxy),
      transaction: (callback: (transaction: typeof proxy) => Promise<unknown>) => callback(proxy),
    },
  }
})

const classify = vi.hoisted(() => vi.fn(() => Promise.resolve(false)))
vi.mock('@/lib/categories/classify', () => ({ classifyArtifactVersion: classify }))
vi.mock('@/lib/audit', () => ({ recordAuditEvent: () => Promise.resolve() }))

const { markVersionReady } = await import('@/lib/artifacts/bundle-write')
const { appendVersion } = await import('@/lib/artifacts/versions')

const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555'
const VERSION_ID = '22222222-3333-4444-8555-666666666666'
const OWNER_ID = '7f3e0000-0000-4000-8000-000000000001'

function when(pattern: RegExp, rows: unknown[][]): Responder {
  return (statement) => (pattern.test(statement.sql) ? rows : undefined)
}

function statementsMatching(pattern: RegExp): Statement[] {
  return harness.statements.filter((statement) => pattern.test(statement.sql))
}

const LOCK_ARTIFACT = /^select .* from "artifacts" .*for update$/
const FLIP_VERSION = /^update "artifact_versions" set "status"/
const REPOINT_ARTIFACT = /^update "artifacts" set "current_version_id"/

beforeEach(() => {
  harness.statements.length = 0
  harness.responders.length = 0
  classify.mockClear()
})

describe('markVersionReady', () => {
  it('flips a pending version and repoints the artifact when it is newer', async () => {
    harness.responders.push(
      when(LOCK_ARTIFACT, [[null]]),
      when(FLIP_VERSION, [[1]]),
      when(REPOINT_ARTIFACT, [[ARTIFACT_ID]]),
    )

    const result = await markVersionReady({ artifactId: ARTIFACT_ID, versionId: VERSION_ID })

    expect(result).toEqual({ becameCurrent: true })

    // Only a still-pending version of this artifact may flip.
    const [flip] = statementsMatching(FLIP_VERSION)
    expect(flip?.sql).toMatch(/"status" = \$\d+/)
    expect(flip?.params).toEqual(expect.arrayContaining(['ready', VERSION_ID, ARTIFACT_ID, 'pending']))

    // The repoint compares against the current version's number, and a NULL pointer also flips.
    const [repoint] = statementsMatching(REPOINT_ARTIFACT)
    expect(repoint?.sql).toMatch(/"current_version_id" is null/)
    expect(repoint?.sql).toMatch(/\(select "cv"\."version_no" from "artifact_versions" as "cv" where "cv"\."id" = "artifacts"\."current_version_id"\) < \$\d+/)
    expect(repoint?.params).toContain(1)
  })

  it('leaves a newer current version in place when an older one finishes last', async () => {
    harness.responders.push(
      when(LOCK_ARTIFACT, [['99999999-0000-4000-8000-000000000003']]),
      when(FLIP_VERSION, [[2]]),
      // Zero rows: the pointer already names a version whose number is not below 2.
      when(REPOINT_ARTIFACT, []),
    )

    const result = await markVersionReady({ artifactId: ARTIFACT_ID, versionId: VERSION_ID })

    expect(result).toEqual({ becameCurrent: false })
    expect(statementsMatching(FLIP_VERSION)).toHaveLength(1)
  })

  it('refuses to flip a version that is no longer pending, and never repoints', async () => {
    harness.responders.push(when(LOCK_ARTIFACT, [[null]]), when(FLIP_VERSION, []))

    const failure = await markVersionReady({
      artifactId: ARTIFACT_ID,
      versionId: VERSION_ID,
    }).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    expect((failure as HttpError).code).toBe('INTERNAL_ERROR')
    expect((failure as HttpError).message).toMatch(/no longer pending/)
    expect(statementsMatching(REPOINT_ARTIFACT)).toHaveLength(0)
  })

  it('refuses when the artifact row is gone, and never repoints', async () => {
    harness.responders.push(when(FLIP_VERSION, [[1]]), when(LOCK_ARTIFACT, []))

    await expect(
      markVersionReady({ artifactId: ARTIFACT_ID, versionId: VERSION_ID }),
    ).rejects.toBeInstanceOf(HttpError)
    expect(statementsMatching(REPOINT_ARTIFACT)).toHaveLength(0)
  })

  it('locks the version row before the artifact row, the same order as the pending sweeper', async () => {
    harness.responders.push(
      when(LOCK_ARTIFACT, [[null]]),
      when(FLIP_VERSION, [[1]]),
      when(REPOINT_ARTIFACT, [[ARTIFACT_ID]]),
    )

    await markVersionReady({ artifactId: ARTIFACT_ID, versionId: VERSION_ID })

    const order = harness.statements.map((statement) =>
      FLIP_VERSION.test(statement.sql)
        ? 'flip'
        : LOCK_ARTIFACT.test(statement.sql)
          ? 'lock'
          : REPOINT_ARTIFACT.test(statement.sql)
            ? 'repoint'
            : 'other',
    )
    expect(order).toEqual(['flip', 'lock', 'repoint'])
  })
})

describe('appendVersion · expectedVersionNo against the current ready version', () => {
  const acceptingStore: ObjectStore = {
    ensureBucket: () => Promise.resolve(),
    putObject: () => Promise.resolve(),
    getObject: () => Promise.reject(new Error('not used')),
    getObjectStream: () => Promise.reject(new Error('not used')),
    presignGetUrl: () => Promise.reject(new Error('not used')),
    listKeys: () => Promise.reject(new Error('not used')),
    deletePrefix: () => Promise.reject(new Error('not used')),
  }

  const files: BundleFile[] = [
    { path: 'index.html', content: Buffer.from('<!doctype html>', 'utf8') },
  ]

  const CURRENT_VERSION_NO = /^select coalesce\(\(select "cv"\."version_no"/
  const MAX_VERSION_NO = /^select coalesce\(max\(/
  const INSERT_VERSION = /^insert into "artifact_versions"/

  /**
   * Current (ready, pointed-at) version 2 and a pending version 3. `inFlightVersionNo` is what
   * the `filter (...)` aggregate yields: NULL when v3 is older than the sweeper cutoff (an
   * abandoned upload), 3 when it is fresh (another append still uploading).
   */
  function artifactWithPending(inFlightVersionNo: number | null): void {
    harness.responders.push(
      when(/^select "owner_id", "deleted_at", "category_source", "title" from "artifacts"/, [
        [OWNER_ID, null, 'model', 'Title'],
      ]),
      when(CURRENT_VERSION_NO, [[2]]),
      when(MAX_VERSION_NO, [[3, inFlightVersionNo]]),
      when(INSERT_VERSION, [[VERSION_ID]]),
      when(LOCK_ARTIFACT, [[null]]),
      when(FLIP_VERSION, [[4]]),
      when(REPOINT_ARTIFACT, [[ARTIFACT_ID]]),
    )
  }

  it('accepts the ready version number even when a pending version has a higher one', async () => {
    artifactWithPending(null)

    const appended = await appendVersion(
      { artifactId: ARTIFACT_ID, ownerId: OWNER_ID, files, expectedVersionNo: 2 },
      acceptingStore,
    )

    // The new number still skips past the pending v3: the unique index covers every row.
    expect(appended.versionNo).toBe(4)
    const [insert] = statementsMatching(INSERT_VERSION)
    expect(insert?.params).toContain(4)
  })

  it('rejects the pending version number as stale, reporting the ready one', async () => {
    artifactWithPending(null)

    const failure = await appendVersion(
      { artifactId: ARTIFACT_ID, ownerId: OWNER_ID, files, expectedVersionNo: 3 },
      acceptingStore,
    ).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    expect((failure as HttpError).code).toBe('VERSION_CONFLICT')
    expect((failure as HttpError).details).toEqual({ expectedVersionNo: 3, currentVersionNo: 2 })
    expect(statementsMatching(INSERT_VERSION)).toHaveLength(0)
  })

  it('refuses while a fresh pending version is still uploading: two clients who saw v2', async () => {
    artifactWithPending(3)

    const failure = await appendVersion(
      { artifactId: ARTIFACT_ID, ownerId: OWNER_ID, files, expectedVersionNo: 2 },
      acceptingStore,
    ).catch((thrown: unknown) => thrown)

    expect(failure).toBeInstanceOf(HttpError)
    expect((failure as HttpError).code).toBe('VERSION_CONFLICT')
    expect((failure as HttpError).details).toEqual({
      expectedVersionNo: 2,
      currentVersionNo: 2,
      inFlightVersionNo: 3,
    })
    expect(statementsMatching(INSERT_VERSION)).toHaveLength(0)

    // The in-flight window is the sweeper's own cutoff, compared against the ready version.
    const [numbers] = statementsMatching(MAX_VERSION_NO)
    expect(numbers?.sql).toMatch(/filter \(where "status" = 'pending'/)
    expect(numbers?.sql).toMatch(/make_interval\(mins => \$\d+\)/)
    expect(numbers?.params).toEqual(expect.arrayContaining([2, 15]))
  })

  it('appends over a fresh pending version when forced (no expectedVersionNo)', async () => {
    artifactWithPending(3)

    const appended = await appendVersion(
      { artifactId: ARTIFACT_ID, ownerId: OWNER_ID, files },
      acceptingStore,
    )

    expect(appended.versionNo).toBe(4)
  })

  it('runs classification inline outside a request scope, after the version is ready', async () => {
    artifactWithPending(null)

    await appendVersion({ artifactId: ARTIFACT_ID, ownerId: OWNER_ID, files }, acceptingStore)

    expect(classify).toHaveBeenCalledTimes(1)
    expect(classify).toHaveBeenCalledWith({ artifactId: ARTIFACT_ID, title: 'Title', files })
  })
})
