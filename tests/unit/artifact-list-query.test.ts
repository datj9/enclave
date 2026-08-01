import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  decodeListCursor,
  encodeListCursor,
  parseListQuery,
} from '@/lib/artifacts/list-query'
import { artifactViewUrl, slugFromTitle } from '@/lib/artifacts/naming'
import { env } from '@/env'
import { artifactPrefix, storageKey, versionPrefix } from '@/lib/storage/object-store'

const CURSOR = { createdAt: '2026-08-01T10:00:00.000Z', id: '7f3e0000-0000-4000-8000-000000000001' }

function query(search: string) {
  return parseListQuery(new URLSearchParams(search))
}

describe('list cursor', () => {
  it('round-trips a position', () => {
    expect(decodeListCursor(encodeListCursor(CURSOR))).toEqual(CURSOR)
  })

  it('encodes to base64url so it is URL-safe unescaped', () => {
    expect(encodeListCursor(CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it.each([
    ['a cursor with no separator', Buffer.from('nonsense').toString('base64url')],
    ['a cursor with an unparseable timestamp', Buffer.from('later|abc').toString('base64url')],
    ['a cursor with an empty id', Buffer.from('2026-08-01T10:00:00.000Z|').toString('base64url')],
    ['arbitrary junk', 'not-a-cursor'],
  ])('rejects %s', (_label, raw) => {
    expect(decodeListCursor(raw)).toBeUndefined()
  })
})

describe('parseListQuery', () => {
  it('defaults to no cursor and the default limit', () => {
    expect(query('')).toEqual({ ok: true, value: { limit: DEFAULT_LIST_LIMIT, cursor: undefined } })
  })

  it('treats blank parameters as absent', () => {
    expect(query('limit=&cursor=')).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIST_LIMIT, cursor: undefined },
    })
  })

  it('accepts a limit of 1 and of the maximum', () => {
    expect(query('limit=1')).toEqual({ ok: true, value: { limit: 1, cursor: undefined } })
    expect(query(`limit=${MAX_LIST_LIMIT}`)).toEqual({
      ok: true,
      value: { limit: MAX_LIST_LIMIT, cursor: undefined },
    })
  })

  it.each([
    ['zero', 'limit=0'],
    ['above the maximum', `limit=${MAX_LIST_LIMIT + 1}`],
    ['negative', 'limit=-1'],
    ['not a number', 'limit=lots'],
    ['a float', 'limit=1.5'],
  ])('rejects a limit that is %s', (_label, search) => {
    expect(query(search)).toEqual({ ok: false, details: { parameter: 'limit', max: MAX_LIST_LIMIT } })
  })

  it('carries a valid cursor through', () => {
    expect(query(`cursor=${encodeListCursor(CURSOR)}`)).toEqual({
      ok: true,
      value: { limit: DEFAULT_LIST_LIMIT, cursor: CURSOR },
    })
  })

  it('rejects a tampered cursor', () => {
    expect(query('cursor=tampered')).toEqual({ ok: false, details: { parameter: 'cursor' } })
  })
})

describe('slugFromTitle', () => {
  it.each([
    ['Sales dash', 'sales-dash'],
    ['  Q3 // Revenue  ', 'q3-revenue'],
    ['Ünïcode Títle', 'unicode-title'],
    ['!!!', 'artifact'],
    ['', 'artifact'],
  ])('turns %j into %j', (title, expected) => {
    expect(slugFromTitle(title)).toBe(expected)
  })

  it('truncates without leaving a trailing hyphen', () => {
    const slug = slugFromTitle(`${'a'.repeat(79)} tail`)

    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('artifactViewUrl', () => {
  it('fills {id} in the origin template and always ends in a slash', () => {
    // Read from env rather than hard-coding a host: the template differs per deployment (§5.7).
    const expected = `${env.ARTIFACT_ORIGIN_TEMPLATE.replace('{id}', '7f3e')}/`

    expect(artifactViewUrl('7f3e')).toBe(expected)
    expect(artifactViewUrl('7f3e')).toContain('7f3e')
  })
})

describe('storage keys (§4.4)', () => {
  it('lays objects out under artifacts/{artifactId}/{versionId}/', () => {
    expect(versionPrefix('7f3e', '9a1c')).toBe('artifacts/7f3e/9a1c/')
    expect(storageKey('7f3e', '9a1c', 'assets/app.js')).toBe('artifacts/7f3e/9a1c/assets/app.js')
  })

  // The purge job deletes one prefix per artifact; if this containment ever broke, it would leave
  // the objects of every version behind while removing the rows that point at them.
  it('covers every version of an artifact from the artifact prefix alone', () => {
    expect(artifactPrefix('7f3e')).toBe('artifacts/7f3e/')
    expect(versionPrefix('7f3e', '9a1c').startsWith(artifactPrefix('7f3e'))).toBe(true)
    expect(storageKey('7f3e', '9a1c', 'index.html').startsWith(artifactPrefix('7f3e'))).toBe(true)
  })
})
