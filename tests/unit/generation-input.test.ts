import { describe, expect, it } from 'vitest'
import { parsePrompt, titleFromPrompt } from '@/lib/generation/run'
import { encodeSseEvent } from '@/lib/generation/sse'
import { HttpError } from '@/lib/http'

/** The pure edges of the generation route: what a prompt must be, and the §5.4 frame format. */

const decoder = new TextDecoder()

describe('parsePrompt', () => {
  it('accepts a prompt and trims it', () => {
    expect(parsePrompt({ prompt: '  a countdown timer  ' })).toBe('a countdown timer')
  })

  it.each([
    ['a missing body', undefined],
    ['a body that is not an object', 'a countdown timer'],
    ['a missing prompt', {}],
    ['a non-string prompt', { prompt: 42 }],
    ['a blank prompt', { prompt: '\n  \t' }],
  ])('rejects %s', (_label, body) => {
    expect(() => parsePrompt(body)).toThrow(HttpError)
    expect(() => parsePrompt(body)).toThrow('Describe what you want built')
  })

  it('rejects a prompt past the length cap', () => {
    expect(() => parsePrompt({ prompt: 'x'.repeat(4001) })).toThrow(/under 4000 characters/)
  })

  it('accepts a prompt exactly at the cap', () => {
    expect(parsePrompt({ prompt: 'x'.repeat(4000) })).toHaveLength(4000)
  })
})

describe('titleFromPrompt', () => {
  it('uses the first line', () => {
    expect(titleFromPrompt('a countdown timer\nwith fireworks')).toBe('a countdown timer')
  })

  it('truncates a long first line with an ellipsis', () => {
    const title = titleFromPrompt('x'.repeat(200))

    expect(title).toHaveLength(80)
    expect(title.endsWith('…')).toBe(true)
  })

  it('falls back when the first line is blank', () => {
    expect(titleFromPrompt('\nsecond line wins nothing')).toBe('Untitled artifact')
  })
})

describe('encodeSseEvent', () => {
  it('writes one framed event per §5.4', () => {
    const frame = decoder.decode(encodeSseEvent('file_end', { path: 'index.html', bytes: 312 }))

    expect(frame).toBe('event: file_end\ndata: {"path":"index.html","bytes":312}\n\n')
  })
})
