import { describe, expect, it } from 'vitest'
import { parseCreateArtifactBody } from '@/lib/bundle/input'

function expectRejection(body: unknown): Record<string, unknown> {
  const parsed = parseCreateArtifactBody(body)

  expect(parsed.ok).toBe(false)
  if (parsed.ok) throw new Error('expected a rejection')
  return parsed.details
}

describe('parseCreateArtifactBody', () => {
  it('decodes the S2 worked-example body', () => {
    const parsed = parseCreateArtifactBody({
      title: 'Sales dash',
      visibility: 'private',
      files: [
        { path: 'index.html', content: '<!doctype html><script src=./app.js></script>' },
        { path: 'app.js', content: 'console.log(1)' },
      ],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.title).toBe('Sales dash')
    expect(parsed.value.visibility).toBe('private')
    expect(parsed.value.files.map((file) => file.path)).toEqual(['index.html', 'app.js'])
    expect(parsed.value.files[1]?.content.toString('utf8')).toBe('console.log(1)')
  })

  it('defaults visibility to private, matching US-3 AC1', () => {
    const parsed = parseCreateArtifactBody({
      title: 'No visibility given',
      files: [{ path: 'index.html', content: 'hi' }],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.visibility).toBe('private')
  })

  it('accepts visibility org', () => {
    const parsed = parseCreateArtifactBody({
      title: 'Shared',
      visibility: 'org',
      files: [{ path: 'index.html', content: 'hi' }],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.visibility).toBe('org')
  })

  it('trims the title', () => {
    const parsed = parseCreateArtifactBody({
      title: '  Padded  ',
      files: [{ path: 'index.html', content: 'hi' }],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.title).toBe('Padded')
  })

  it('decodes base64 content to the exact bytes', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])

    const parsed = parseCreateArtifactBody({
      title: 'Binary',
      files: [
        { path: 'index.html', content: 'hi' },
        { path: 'logo.png', contentBase64: bytes.toString('base64') },
      ],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.files[1]?.content.equals(bytes)).toBe(true)
  })

  it.each([
    ['a missing title', { files: [{ path: 'index.html', content: 'hi' }] }],
    ['an empty title', { title: '   ', files: [{ path: 'index.html', content: 'hi' }] }],
    ['a non-object body', 'not a body'],
    ['a null body', null],
    ['an unknown visibility', { title: 'x', visibility: 'world', files: [] }],
    ['an empty file array', { title: 'x', files: [] }],
    ['a missing file array', { title: 'x' }],
    ['a non-string path', { title: 'x', files: [{ path: 7, content: 'hi' }] }],
  ])('rejects %s', (_label, body) => {
    expect(expectRejection(body)).toHaveProperty('fields')
  })

  it('rejects a file carrying neither content nor contentBase64', () => {
    expect(expectRejection({ title: 'x', files: [{ path: 'index.html' }] })).toEqual({
      path: 'index.html',
      reason: 'content_missing',
    })
  })

  it('rejects a file carrying both content and contentBase64', () => {
    const details = expectRejection({
      title: 'x',
      files: [{ path: 'index.html', content: 'hi', contentBase64: 'aGk=' }],
    })

    expect(details).toEqual({ path: 'index.html', reason: 'content_ambiguous' })
  })

  it.each([
    ['bad padding', 'aGk'],
    ['a non-base64 character', 'aG k='],
    ['base64url instead of base64', 'a-_k'],
  ])('rejects contentBase64 with %s', (_label, contentBase64) => {
    const details = expectRejection({
      title: 'x',
      files: [{ path: 'index.html', contentBase64 }],
    })

    expect(details).toEqual({ path: 'index.html', reason: 'content_base64_invalid' })
  })

  it('accepts empty base64 as a zero-byte file', () => {
    const parsed = parseCreateArtifactBody({
      title: 'x',
      files: [{ path: 'index.html', contentBase64: '' }],
    })

    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.files[0]?.content.byteLength).toBe(0)
  })
})
