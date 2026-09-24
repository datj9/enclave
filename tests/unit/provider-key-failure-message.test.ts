import { describe, expect, it } from 'vitest'

import { envelopeMessage, failureMessage } from '@app/settings/keys/failure-message'

/**
 * The provider-key manager shows the server's reason for a refused save — a base URL aimed at a
 * loopback, link-local, metadata or blocked private address comes back as a 422 whose message is
 * the only useful thing to say — and falls back to its generic line for anything else.
 */

const FALLBACK = 'That key could not be saved. Check it and try again.'
const REFUSED =
  'That base URL points at a loopback address, which this instance does not allow for provider keys.'

function jsonResponse(body: unknown, status = 422): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('envelopeMessage', () => {
  it('reads the message out of the HttpError envelope', () => {
    expect(envelopeMessage({ error: { code: 'VALIDATION_FAILED', message: REFUSED } })).toBe(
      REFUSED,
    )
  })

  it('trims surrounding whitespace', () => {
    expect(envelopeMessage({ error: { message: `  ${REFUSED}\n` } })).toBe(REFUSED)
  })

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['a body without error', { data: {} }],
    ['an error that is a string', { error: 'bad' }],
    ['an error with no message', { error: { code: 'X' } }],
    ['a non-string message', { error: { message: 42 } }],
    ['an empty message', { error: { message: '   ' } }],
    ['an implausibly long message', { error: { message: 'x'.repeat(301) } }],
  ])('returns null for %s', (_label, body) => {
    expect(envelopeMessage(body)).toBeNull()
  })
})

describe('failureMessage', () => {
  it('shows the 422 VALIDATION_FAILED message from the settings/keys route', async () => {
    const response = jsonResponse({ error: { code: 'VALIDATION_FAILED', message: REFUSED } })
    expect(await failureMessage(response, FALLBACK)).toBe(REFUSED)
  })

  it('falls back when the body is not JSON', async () => {
    const response = new Response('<html>Bad gateway</html>', { status: 502 })
    expect(await failureMessage(response, FALLBACK)).toBe(FALLBACK)
  })

  it('falls back when the JSON is not an envelope', async () => {
    expect(await failureMessage(jsonResponse({ ok: false }, 400), FALLBACK)).toBe(FALLBACK)
  })

  it('falls back on an empty body', async () => {
    expect(await failureMessage(new Response(null, { status: 500 }), FALLBACK)).toBe(FALLBACK)
  })
})
