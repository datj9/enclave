import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { afterCursor, cursorTimestamp } from '@/lib/artifacts/list'
import { decodeListCursor, encodeListCursor } from '@/lib/artifacts/list-query'
import { HttpError } from '@/lib/http'

/**
 * The list cursor carries `created_at` at Postgres's microsecond precision. A millisecond cursor
 * sits up to 999µs before its row, so `created_at < cursor` skipped every row created later in
 * the same millisecond. These pin the normalisation and the predicate; the round trip against a
 * real table lives in tests/integration/artifact-store.test.ts.
 */

const ID = '11111111-2222-4333-8444-555555555555'
const dialect = new PgDialect()

describe('cursorTimestamp', () => {
  it('keeps a microsecond cursor verbatim', () => {
    expect(cursorTimestamp('2026-09-23T10:11:12.123456Z')).toBe('2026-09-23T10:11:12.123456Z')
  })

  it('accepts a pre-upgrade millisecond cursor best-effort', () => {
    expect(cursorTimestamp('2026-09-23T10:11:12.123Z')).toBe('2026-09-23T10:11:12.123Z')
  })

  it('rejects an unparseable timestamp as a validation error, not a database error', () => {
    const failure = (() => {
      try {
        return cursorTimestamp('not a date')
      } catch (thrown) {
        return thrown
      }
    })()
    expect(failure).toBeInstanceOf(HttpError)
    expect((failure as HttpError).code).toBe('VALIDATION_FAILED')
    expect((failure as HttpError).details).toEqual({ parameter: 'cursor' })
  })

  it.each(['0000-01-01T00:00:00.000Z', '+275760-09-13T00:00:00.000Z'])(
    'rejects %s, which JS parses but Postgres cannot cast',
    (raw) => {
      expect(() => cursorTimestamp(raw)).toThrow(HttpError)
    },
  )

  it('never passes an out-of-range microsecond timestamp through verbatim', () => {
    // JS rolls Feb 30 over to Mar 2 (2026 is not a leap year); Postgres would reject the literal.
    expect(cursorTimestamp('2026-02-30T00:00:00.000001Z')).toBe('2026-03-02T00:00:00.000Z')
  })

  it('survives the opaque encoding with every digit intact', () => {
    const cursor = { createdAt: '2026-09-23T10:11:12.123456Z', id: ID }
    expect(decodeListCursor(encodeListCursor(cursor))).toEqual(cursor)
  })
})

describe('afterCursor', () => {
  it('compares against the cursor cast to timestamptz, not a JS Date', () => {
    const predicate = afterCursor({ createdAt: '2026-09-23T10:11:12.123456Z', id: ID })
    if (predicate === undefined) throw new Error('expected a predicate')

    const rendered = dialect.sqlToQuery(predicate)
    expect(rendered.sql).toMatch(/"artifacts"\."created_at" < \$1::timestamptz/)
    expect(rendered.sql).toMatch(/"artifacts"\."created_at" = \$\d::timestamptz/)
    expect(rendered.params).toEqual(['2026-09-23T10:11:12.123456Z', '2026-09-23T10:11:12.123456Z', ID])
  })

  it('rejects a non-uuid id before it reaches the uuid comparison', () => {
    expect(() => afterCursor({ createdAt: '2026-09-23T10:11:12.123456Z', id: 'nope' })).toThrow(
      HttpError,
    )
  })
})
