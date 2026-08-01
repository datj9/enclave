import { describe, expect, it } from 'vitest'
import { FileBlockParser, type ParseEvent } from '@/lib/bundle/parse-file-blocks'
import type { BundleLimits } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'

/**
 * grill-result §5.5, every rule. Zero network, zero storage, zero database — the parser is a pure
 * state machine, so these are the tests the S6 acceptance criterion holds at 100% of branches.
 *
 * The chunk-boundary suite is the point of the file: the same fixture is replayed split at every
 * single character, which puts a boundary inside `<file path="…">` and inside `</file>` on some
 * iteration. A parser that scans for whole tags per delta fails there.
 */

const INDEX_CONTENT = '<!doctype html><title>Countdown</title>'
const APP_CONTENT = 'setInterval(() => {}, 1000)'

const WELL_FORMED =
  `<file path="index.html">\n${INDEX_CONTENT}\n</file>\n` +
  `<file path="app.js">\n${APP_CONTENT}\n</file>\n`

const GENEROUS_LIMITS: BundleLimits = {
  maxFiles: 50,
  maxFileBytes: 2_097_152,
  maxTotalBytes: 10_485_760,
}

interface ParseRun {
  readonly events: readonly ParseEvent[]
  readonly parser: FileBlockParser
}

function feed(chunks: readonly string[], limits: BundleLimits = GENEROUS_LIMITS): ParseRun {
  const parser = new FileBlockParser(limits)
  const events = chunks.flatMap((chunk) => [...parser.push(chunk)])
  return { events, parser }
}

function contentByPath(events: readonly ParseEvent[]): Record<string, string> {
  const contents: Record<string, string> = {}
  for (const event of events) {
    if (event.kind === 'chunk') contents[event.path] = (contents[event.path] ?? '') + event.text
  }
  return contents
}

/** The ordered shape of the stream, with chunk payloads collapsed so splits are comparable. */
function eventShape(events: readonly ParseEvent[]): string[] {
  return events
    .filter((event) => event.kind !== 'chunk')
    .map((event) =>
      event.kind === 'file_start' ? `file_start:${event.path}` : `file_end:${event.path}:${event.bytes}`,
    )
}

function filesOf(parser: FileBlockParser): Record<string, string> {
  return Object.fromEntries(parser.finish().map((file) => [file.path, file.content.toString('utf8')]))
}

function thrownBy(run: () => unknown): HttpError {
  try {
    run()
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected the parser to throw')
}

describe('FileBlockParser · well-formed output', () => {
  it('emits file_start, chunks, then file_end for each block in order', () => {
    const { events, parser } = feed([WELL_FORMED])

    expect(eventShape(events)).toEqual([
      'file_start:index.html',
      `file_end:index.html:${INDEX_CONTENT.length}`,
      'file_start:app.js',
      `file_end:app.js:${APP_CONTENT.length}`,
    ])
    expect(contentByPath(events)).toEqual({ 'index.html': INDEX_CONTENT, 'app.js': APP_CONTENT })
    expect(filesOf(parser)).toEqual({ 'index.html': INDEX_CONTENT, 'app.js': APP_CONTENT })
  })

  it('reports file_end bytes in bytes, not characters', () => {
    const content = 'const label = "café ☕"'
    const { events } = feed([`<file path="index.html">\n${content}\n</file>`])
    const fileEnd = events.find((event) => event.kind === 'file_end')

    expect(fileEnd).toEqual({
      kind: 'file_end',
      path: 'index.html',
      bytes: Buffer.byteLength(content, 'utf8'),
    })
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(content.length)
  })

  it('accepts CRLF output and keeps neither framing line break', () => {
    const { parser } = feed([`<file path="index.html">\r\n${INDEX_CONTENT}\r\n</file>\r\n`])

    expect(filesOf(parser)).toEqual({ 'index.html': INDEX_CONTENT })
  })

  it('accepts content that starts on the same line as the open tag', () => {
    const { parser } = feed([`<file path="index.html">${INDEX_CONTENT}</file>`])

    expect(filesOf(parser)).toEqual({ 'index.html': INDEX_CONTENT })
  })

  it('accepts an empty file and reports zero bytes', () => {
    const { events, parser } = feed([`<file path="index.html">\n</file>`])

    expect(eventShape(events)).toEqual(['file_start:index.html', 'file_end:index.html:0'])
    expect(filesOf(parser)).toEqual({ 'index.html': '' })
  })

  it('allows blank lines between blocks', () => {
    const { parser } = feed([
      `<file path="app.js">\n${APP_CONTENT}\n</file>\n\n  \n<file path="index.html">\nx\n</file>`,
    ])

    expect(Object.keys(filesOf(parser))).toEqual(['app.js', 'index.html'])
  })

  it('reads the bundle limits from the environment when none are supplied', () => {
    const parser = new FileBlockParser()
    parser.push(`<file path="index.html">\n${INDEX_CONTENT}\n</file>`)

    expect(filesOf(parser)).toEqual({ 'index.html': INDEX_CONTENT })
  })
})

describe('FileBlockParser · arbitrary chunk boundaries', () => {
  const expectedShape = eventShape(feed([WELL_FORMED]).events)
  const expectedFiles = { 'index.html': INDEX_CONTENT, 'app.js': APP_CONTENT }

  it('produces the identical event sequence for every possible two-way split', () => {
    for (let boundary = 1; boundary < WELL_FORMED.length; boundary += 1) {
      const chunks = [WELL_FORMED.slice(0, boundary), WELL_FORMED.slice(boundary)]
      const { events, parser } = feed(chunks)

      expect(eventShape(events), `split at ${boundary}`).toEqual(expectedShape)
      expect(contentByPath(events), `split at ${boundary}`).toEqual(expectedFiles)
      expect(filesOf(parser), `split at ${boundary}`).toEqual(expectedFiles)
    }
  })

  it('survives one character at a time', () => {
    const { events, parser } = feed([...WELL_FORMED])

    expect(eventShape(events)).toEqual(expectedShape)
    expect(filesOf(parser)).toEqual(expectedFiles)
  })

  it('splits inside the open tag without losing the path', () => {
    const { events } = feed(['<file pa', 'th="index.html">\nx\n</file>'])

    expect(eventShape(events)).toEqual(['file_start:index.html', 'file_end:index.html:1'])
  })

  it('splits inside the closing tag without treating it as content', () => {
    const { events, parser } = feed(['<file path="index.html">\nx\n</fi', 'le>'])

    expect(contentByPath(events)).toEqual({ 'index.html': 'x' })
    expect(filesOf(parser)).toEqual({ 'index.html': 'x' })
  })

  it('waits for the rest of a lone carriage return before deciding it is content', () => {
    const { parser } = feed(['<file path="index.html">', '\r', '\nx\n</file>'])

    expect(filesOf(parser)).toEqual({ 'index.html': 'x' })
  })

  it('holds text that could still become an open tag', () => {
    const { events } = feed(['<fi'])

    expect(events).toEqual([])
  })
})

describe('FileBlockParser · malformed output', () => {
  it('rejects prose before the first block', () => {
    const error = thrownBy(() => feed(['Sure! Here is your artifact:\n<file path="index.html">']))

    expect(error).toMatchObject({ code: 'MALFORMED_MODEL_OUTPUT', status: 502 })
    expect(error.details).toEqual({ reason: 'text_outside_file_block' })
  })

  it('rejects prose between two blocks', () => {
    const error = thrownBy(() =>
      feed([`<file path="index.html">\nx\n</file>\nand now the script:\n<file path="app.js">`]),
    )

    expect(error.code).toBe('MALFORMED_MODEL_OUTPUT')
  })

  it('persists nothing when the final block is never closed', () => {
    const { parser } = feed([`<file path="index.html">\n${INDEX_CONTENT}`])
    const error = thrownBy(() => parser.finish())

    expect(error).toMatchObject({ code: 'MALFORMED_MODEL_OUTPUT', status: 502 })
    expect(error.details).toEqual({ reason: 'unterminated_file_block' })
  })

  it('rejects trailing prose after the last block as soon as it arrives', () => {
    const error = thrownBy(() => feed([`<file path="index.html">\nx\n</file>\nHope that helps!`]))

    expect(error.details).toEqual({ reason: 'text_outside_file_block' })
  })

  it('rejects a stream that ends inside a truncated open tag', () => {
    const { parser } = feed([`<file path="index.html">\nx\n</file>\n<fi`])

    expect(thrownBy(() => parser.finish()).details).toEqual({ reason: 'text_outside_file_block' })
  })

  it('rejects a stream that contained no block at all', () => {
    const { parser } = feed([''])

    expect(thrownBy(() => parser.finish()).details).toEqual({ reason: 'no_file_blocks' })
  })

  it('rejects an open tag with no path attribute', () => {
    const error = thrownBy(() => feed(['<file>\nx\n</file>']))

    expect(error.details).toEqual({ reason: 'malformed_open_tag' })
  })

  it('rejects a tag that only looks like a file block', () => {
    expect(thrownBy(() => feed(['<files path="index.html">'])).code).toBe('MALFORMED_MODEL_OUTPUT')
  })

  it('reports a message that leaks no server internals', () => {
    expect(thrownBy(() => feed(['nope'])).message).toBe('The model did not return a valid artifact')
  })
})

describe('FileBlockParser · bundle rules from validateBundle', () => {
  it('aborts the parse on a traversal path', () => {
    const error = thrownBy(() => feed(['<file path="a/../../b.js">']))

    expect(error).toMatchObject({ code: 'PATH_INVALID', status: 422 })
    expect(error.details).toEqual({ path: 'a/../../b.js' })
  })

  it('aborts the parse on an absolute path', () => {
    expect(thrownBy(() => feed(['<file path="/etc/passwd.txt">'])).code).toBe('PATH_INVALID')
  })

  it('aborts the parse on a disallowed extension', () => {
    expect(thrownBy(() => feed(['<file path="shell.php">'])).code).toBe('FILE_TYPE_NOT_ALLOWED')
  })

  it('rejects a duplicate path instead of letting the last one win', () => {
    const error = thrownBy(() =>
      feed([`<file path="index.html">\nfirst\n</file>\n<file path="index.html">\nsecond\n</file>`]),
    )

    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(error.details).toEqual({ reason: 'duplicate_path', path: 'index.html' })
  })

  it('requires index.html', () => {
    const { parser } = feed([`<file path="app.js">\n${APP_CONTENT}\n</file>`])
    const error = thrownBy(() => parser.finish())

    expect(error).toMatchObject({ code: 'ENTRY_MISSING', status: 422 })
    expect(error.details).toEqual({ expected: 'index.html' })
  })

  it('tolerates index.html arriving after another file', () => {
    const { parser } = feed([
      `<file path="app.js">\n${APP_CONTENT}\n</file>\n<file path="index.html">\nx\n</file>`,
    ])

    expect(Object.keys(filesOf(parser))).toEqual(['app.js', 'index.html'])
  })

  it('aborts as soon as one file passes the per-file limit', () => {
    const error = thrownBy(() =>
      feed([`<file path="index.html">\n${'a'.repeat(40)}\n</file>`], {
        ...GENEROUS_LIMITS,
        maxFileBytes: 16,
      }),
    )

    expect(error).toMatchObject({ code: 'BUNDLE_TOO_LARGE', status: 413 })
    expect(error.details).toEqual({ path: 'index.html', maxFileBytes: 16 })
  })

  it('aborts as soon as the bundle passes the total limit', () => {
    const error = thrownBy(() =>
      feed(
        [
          `<file path="index.html">\n${'a'.repeat(20)}\n</file>\n<file path="app.js">\n${'b'.repeat(20)}\n</file>`,
        ],
        { ...GENEROUS_LIMITS, maxTotalBytes: 30 },
      ),
    )

    expect(error).toMatchObject({ code: 'BUNDLE_TOO_LARGE' })
    expect(error.details).toEqual({ maxTotalBytes: 30 })
  })

  it('aborts when the model opens more files than the limit allows', () => {
    const error = thrownBy(() =>
      feed(
        [
          `<file path="index.html">\nx\n</file>\n<file path="a.js">\nx\n</file>\n<file path="b.js">`,
        ],
        { ...GENEROUS_LIMITS, maxFiles: 2 },
      ),
    )

    expect(error).toMatchObject({ code: 'BUNDLE_TOO_LARGE' })
    expect(error.details).toEqual({ fileCount: 3, maxFiles: 2 })
  })
})
