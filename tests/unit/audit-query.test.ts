import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  decodeAuditCursor,
  encodeAuditCursor,
  parseAuditFilter,
} from '@/lib/admin/audit-query'

// audit-viewer.tsx imports a CSS module for styling only; it plays no part in queryFrom's
// string-building logic under test below, and vitest has no CSS-module transform configured.
vi.mock('@app/admin/admin.module.css', () => ({ default: new Proxy({}, { get: () => '' }) }))

const ACTOR_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const ARTIFACT_ID = '9c858901-8a57-4791-81fe-4c455b099bc9'

function parse(query: string) {
  return parseAuditFilter(new URLSearchParams(query))
}

describe('audit filter parsing', () => {
  it('defaults to no filters and the default page size', () => {
    const parsed = parse('')

    expect(parsed).toEqual({
      ok: true,
      value: {
        action: undefined,
        actorUserId: undefined,
        artifactId: undefined,
        from: undefined,
        to: undefined,
        limit: DEFAULT_AUDIT_LIMIT,
        cursor: undefined,
      },
    })
  })

  it('accepts every filter at once', () => {
    const parsed = parse(
      `action=user.invite&actorUserId=${ACTOR_ID}&artifactId=${ARTIFACT_ID}` +
        '&from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&limit=10',
    )

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.action).toBe('user.invite')
    expect(parsed.value.actorUserId).toBe(ACTOR_ID)
    expect(parsed.value.artifactId).toBe(ARTIFACT_ID)
    expect(parsed.value.from?.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(parsed.value.to?.toISOString()).toBe('2026-08-02T00:00:00.000Z')
    expect(parsed.value.limit).toBe(10)
  })

  it('treats an empty parameter as absent rather than as a filter on the empty string', () => {
    const parsed = parse('action=&actorUserId=&artifactId=&from=&to=&cursor=')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.action).toBeUndefined()
    expect(parsed.value.cursor).toBeUndefined()
  })

  it.each([
    ['action=user.exfiltrate', 'action'],
    ['actorUserId=not-a-uuid', 'actorUserId'],
    ['artifactId=1234', 'artifactId'],
    ['from=yesterday', 'from'],
    ['to=whenever', 'to'],
    ['from=2026-08-02T00:00:00Z&to=2026-08-01T00:00:00Z', 'to'],
    ['cursor=!!!not-base64!!!', 'cursor'],
    ['limit=0', 'limit'],
    [`limit=${MAX_AUDIT_LIMIT + 1}`, 'limit'],
    ['limit=-1', 'limit'],
    ['limit=ten', 'limit'],
    // A zone-less moment would silently be read in the Node host's own offset — refused instead.
    ['from=2026-08-01T09:00', 'from'],
    ['to=2026-08-01T17:00', 'to'],
    // Date-only would silently be read as UTC midnight — refused instead.
    ['from=2026-08-01', 'from'],
  ])('rejects %s naming the %s parameter', (query, parameter) => {
    const parsed = parse(query)

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.details['parameter']).toBe(parameter)
  })

  it('names the reason when a zone-less from is refused', () => {
    const parsed = parse('from=2026-08-01T09:00')

    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.details['parameter']).toBe('from')
    expect(String(parsed.details['reason'])).toMatch(/RFC 3339|explicit zone/i)
  })

  it('accepts the maximum page size', () => {
    const parsed = parse(`limit=${MAX_AUDIT_LIMIT}`)

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.limit).toBe(MAX_AUDIT_LIMIT)
  })

  it('accepts an explicit offset and treats it as equal to the matching Z instant', () => {
    const parsed = parse('from=2026-08-01T09:00:00%2B01:00')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.from?.toISOString()).toBe('2026-08-01T08:00:00.000Z')
  })

  it('accepts a six-digit fractional second and lowercase z', () => {
    const parsed = parse('from=2026-08-01T09:00:00.123456z')

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.from?.toISOString()).toBe('2026-08-01T09:00:00.123Z')
  })
})

describe('the browser-side query builder converts wall-clock input to an absolute instant', () => {
  const ORIGINAL_TZ = process.env.TZ

  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  it('resolves a datetime-local value typed in a UTC+1 browser to the matching Z instant', async () => {
    process.env.TZ = 'Europe/London'
    const { queryFrom } = await import('@app/admin/audit/audit-viewer')

    const form = new FormData()
    form.set('from', '2026-08-01T09:00')

    expect(queryFrom(form, null)).toBe('from=2026-08-01T08%3A00%3A00.000Z')
  })

  it('refuses an unparseable moment rather than dropping the filter', async () => {
    const { queryFrom } = await import('@app/admin/audit/audit-viewer')

    const form = new FormData()
    form.set('from', 'not-a-date')

    expect(() => queryFrom(form, null)).toThrow(/from/)
  })
})

describe('audit cursor', () => {
  it('round-trips a keyset position', () => {
    const cursor = { at: '2026-08-01T10:00:00.000Z', id: 4821 }

    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor)
  })

  it('is opaque — the encoded form is not the raw timestamp', () => {
    const encoded = encodeAuditCursor({ at: '2026-08-01T10:00:00.000Z', id: 1 })

    expect(encoded).not.toContain('2026')
  })

  it.each([
    ['', 'empty'],
    [Buffer.from('2026-08-01T10:00:00.000Z', 'utf8').toString('base64url'), 'no separator'],
    [Buffer.from('not-a-date|5', 'utf8').toString('base64url'), 'an unparseable timestamp'],
    [Buffer.from('2026-08-01T10:00:00.000Z|abc', 'utf8').toString('base64url'), 'a non-numeric id'],
    [Buffer.from('2026-08-01T10:00:00.000Z|-3', 'utf8').toString('base64url'), 'a negative id'],
  ])('rejects a tampered cursor with %s', (encoded) => {
    expect(decodeAuditCursor(encoded)).toBeUndefined()
  })
})
