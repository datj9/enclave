import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NewAuditLogRow } from '@/db/schema/audit-log'

/**
 * The audit writer with Postgres mocked out. What actually lands in the table, and the
 * append-only trigger that guards it, are covered by tests/integration/audit-log.test.ts.
 */

const insertedRows: NewAuditLogRow[] = []
let insertOutcome: 'ok' | 'reject' = 'ok'

vi.mock('@/db', () => ({
  db: {
    insert: () => ({
      values: (row: NewAuditLogRow) => {
        if (insertOutcome === 'reject') return Promise.reject(new Error('connection refused'))
        insertedRows.push(row)
        return Promise.resolve()
      },
    }),
  },
}))

const { REDACTED, normalizeActorIp, recordAuditEvent, sanitizeMetadata } = await import(
  '@/lib/audit'
)

beforeEach(() => {
  insertedRows.length = 0
  insertOutcome = 'ok'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sanitizeMetadata', () => {
  it.each([
    ['prompt'],
    ['Prompt'],
    ['userPrompt'],
    ['prompt_text'],
    ['systemPrompt'],
    ['messages'],
    ['completion'],
    ['content'],
    ['password'],
    ['apiKey'],
    ['api_key'],
    ['secret'],
    ['authorization'],
    ['presignedUrl'],
    ['signed_url'],
    ['plaintext'],
    ['token'],
  ])('redacts %s', (key) => {
    expect(sanitizeMetadata({ [key]: 'draw me a dashboard' })).toEqual({ [key]: REDACTED })
  })

  it('redacts a prompt nested inside another object', () => {
    expect(sanitizeMetadata({ generation: { model: 'x', prompt: 'secret words' } })).toEqual({
      generation: { model: 'x', prompt: REDACTED },
    })
  })

  it('keeps identifiers that merely look secret', () => {
    expect(sanitizeMetadata({ tokenId: 'abc', shareLinkId: 'def' })).toEqual({
      tokenId: 'abc',
      shareLinkId: 'def',
    })
  })

  it('keeps the visibility transition intact', () => {
    expect(sanitizeMetadata({ from: 'private', to: 'org' })).toEqual({ from: 'private', to: 'org' })
  })

  it('returns null when there is no metadata', () => {
    expect(sanitizeMetadata(undefined)).toBeNull()
  })

  it('leaves arrays and primitives alone', () => {
    expect(sanitizeMetadata({ scopes: ['artifacts:read'], count: 2, ok: true, none: null })).toEqual(
      { scopes: ['artifacts:read'], count: 2, ok: true, none: null },
    )
  })
})

describe('normalizeActorIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8::1', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['  203.0.113.7  ', '203.0.113.7'],
  ])('keeps %s', (input, expected) => {
    expect(normalizeActorIp(input)).toBe(expected)
  })

  it.each([['unknown'], [''], ['203.0.113.7:443'], ['not-an-ip']])(
    'drops %s rather than failing the insert',
    (input) => {
      expect(normalizeActorIp(input)).toBeNull()
    },
  )

  it.each([[null], [undefined]])('maps %s to null', (input) => {
    expect(normalizeActorIp(input)).toBeNull()
  })
})

describe('recordAuditEvent', () => {
  it('writes one row with every column mapped', async () => {
    await recordAuditEvent({
      action: 'artifact.visibility_change',
      actorUserId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      actorIp: '203.0.113.7',
      artifactId: '11111111-2222-4333-8444-555555555555',
      metadata: { from: 'private', to: 'org' },
    })

    expect(insertedRows).toEqual([
      {
        action: 'artifact.visibility_change',
        actorUserId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        actorTokenId: null,
        actorShareLinkId: null,
        actorIp: '203.0.113.7',
        artifactId: '11111111-2222-4333-8444-555555555555',
        versionId: null,
        shareLinkId: null,
        metadata: { from: 'private', to: 'org' },
      },
    ])
  })

  it('never writes a prompt, whatever the caller passes', async () => {
    await recordAuditEvent({
      action: 'version.create',
      metadata: { prompt: 'build me a sales dashboard', versionNo: 2 },
    })

    expect(insertedRows[0]?.metadata).toEqual({ prompt: REDACTED, versionNo: 2 })
  })

  it('falls back to stderr instead of throwing when the insert fails', async () => {
    insertOutcome = 'reject'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(recordAuditEvent({ action: 'auth.login_failed' })).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledOnce()
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('"action":"auth.login_failed"')
  })
})
