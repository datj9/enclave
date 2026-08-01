import {
  bundleLimitsFromEnv,
  validateBundle,
  type BundleFile,
  type BundleLimits,
} from '@/lib/bundle/validate'
import { HttpError, type ErrorCode, type ErrorDetails } from '@/lib/http'

/**
 * The incremental `<file path="…">` parser from grill-result §5.5, decision #14. Pure: no network,
 * no storage, no database.
 *
 * Incremental in both directions. It accepts provider deltas split at any character — including
 * inside an open tag or inside `</file>` — and commits a file only when that file's `</file>`
 * arrives, which is what lets the route emit `file_start` / `chunk` / `file_end` while the model is
 * still talking.
 *
 * Path, extension, duplicate and entry rules are not re-implemented here: all of them come from
 * `validateBundle`, called with empty probe contents mid-stream and with the real bundle at
 * `finish()`. The byte limits are additionally enforced streamingly, so an oversized file aborts
 * before it is buffered whole.
 */

export type ParseEvent =
  | { readonly kind: 'file_start'; readonly path: string }
  | { readonly kind: 'chunk'; readonly path: string; readonly text: string }
  | { readonly kind: 'file_end'; readonly path: string; readonly bytes: number }

const OPEN_TAG_START = '<file'
const CLOSE_TAG = '</file>'
const OPEN_TAG_PATTERN = /^<file\s+path="([^"]*)"\s*>$/

/**
 * Characters held back from the tail of an in-progress file so a `</file>` split across deltas is
 * never mistaken for content: six for a partial `</file` plus two for the `\r\n` that may precede
 * it, which is dropped when the block closes.
 */
const TAIL_HOLDBACK = 8

const EMPTY_CONTENT = Buffer.alloc(0)

const MALFORMED_MESSAGE = 'The model did not return a valid artifact'
const TOO_LARGE_MESSAGE = 'The generated artifact exceeds the allowed size'

/** Messages stay generic on purpose: the offending path is model output, everything else is ours. */
function parseError(code: ErrorCode, details: ErrorDetails): HttpError {
  const message = code === 'BUNDLE_TOO_LARGE' ? TOO_LARGE_MESSAGE : MALFORMED_MESSAGE
  return new HttpError(code, message, { details })
}

function malformed(reason: string): HttpError {
  return parseError('MALFORMED_MODEL_OUTPUT', { reason })
}

/** One line terminator right after `>` and right before `</file>` frames the block, not content. */
function withoutTrailingLineBreak(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

interface OpenFile {
  readonly path: string
  readonly pieces: string[]
  characters: number
  leadingBreakConsumed: boolean
}

export class FileBlockParser {
  private buffer = ''
  private open: OpenFile | undefined
  private readonly files: BundleFile[] = []
  private totalCharacters = 0

  constructor(private readonly limits: BundleLimits = bundleLimitsFromEnv()) {}

  /** Consumes one provider delta and returns the events it completed, in order. */
  push(delta: string): readonly ParseEvent[] {
    this.buffer += delta
    const events: ParseEvent[] = []
    let progressed = true
    while (progressed) {
      const open = this.open
      progressed =
        open === undefined
          ? this.stepBetweenBlocks(events)
          : this.stepInsideBlock(open, events)
    }
    return events
  }

  /**
   * Ends the stream. Throws unless every block closed and the bundle passes `validateBundle`, so a
   * caller that persists only the return value can never persist a partial artifact.
   */
  finish(): readonly BundleFile[] {
    if (this.open !== undefined) throw malformed('unterminated_file_block')
    if (this.buffer.trimStart() !== '') throw malformed('text_outside_file_block')
    if (this.files.length === 0) throw malformed('no_file_blocks')

    const validation = validateBundle(this.files, this.limits)
    if (!validation.ok) throw parseError(validation.code, validation.details)
    return this.files
  }

  private stepBetweenBlocks(events: ParseEvent[]): boolean {
    this.buffer = this.buffer.trimStart()
    if (this.buffer === '') return false

    if (!OPEN_TAG_START.startsWith(this.buffer.slice(0, OPEN_TAG_START.length))) {
      throw malformed('text_outside_file_block')
    }
    if (this.buffer.length < OPEN_TAG_START.length) return false

    // The path pattern forbids `>`, so the first one always ends the open tag.
    const tagEnd = this.buffer.indexOf('>')
    if (tagEnd === -1) return false

    const path = OPEN_TAG_PATTERN.exec(this.buffer.slice(0, tagEnd + 1))?.[1]
    if (path === undefined) throw malformed('malformed_open_tag')

    this.assertPathAcceptable(path)
    this.buffer = this.buffer.slice(tagEnd + 1)
    this.open = { path, pieces: [], characters: 0, leadingBreakConsumed: false }
    events.push({ kind: 'file_start', path })
    return true
  }

  private stepInsideBlock(open: OpenFile, events: ParseEvent[]): boolean {
    if (!this.consumeLeadingLineBreak(open)) return false

    const closeIndex = this.buffer.indexOf(CLOSE_TAG)
    if (closeIndex === -1) return this.emitPartialContent(open, events)

    const content = withoutTrailingLineBreak(this.buffer.slice(0, closeIndex))
    this.buffer = this.buffer.slice(closeIndex + CLOSE_TAG.length)
    if (content !== '') this.appendContent(open, content, events)

    this.commitOpenFile(open, events)
    return true
  }

  /** A lone `\r` is ambiguous until the next delta arrives, so the parser waits rather than guess. */
  private consumeLeadingLineBreak(open: OpenFile): boolean {
    if (open.leadingBreakConsumed) return true
    if (this.buffer === '' || this.buffer === '\r') return false

    if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2)
    else if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1)

    open.leadingBreakConsumed = true
    return true
  }

  private emitPartialContent(open: OpenFile, events: ParseEvent[]): boolean {
    const emitLength = this.buffer.length - TAIL_HOLDBACK
    if (emitLength <= 0) return false

    this.appendContent(open, this.buffer.slice(0, emitLength), events)
    this.buffer = this.buffer.slice(emitLength)
    return true
  }

  /**
   * Guards on characters, not bytes: a UTF-8 string is never shorter in bytes than in characters,
   * so this aborts an oversized file early without re-encoding the buffer on every delta. Exact
   * byte totals are checked once, by `validateBundle`.
   */
  private appendContent(open: OpenFile, text: string, events: ParseEvent[]): void {
    open.pieces.push(text)
    open.characters += text.length
    this.totalCharacters += text.length

    if (open.characters > this.limits.maxFileBytes) {
      throw parseError('BUNDLE_TOO_LARGE', {
        path: open.path,
        maxFileBytes: this.limits.maxFileBytes,
      })
    }
    if (this.totalCharacters > this.limits.maxTotalBytes) {
      throw parseError('BUNDLE_TOO_LARGE', { maxTotalBytes: this.limits.maxTotalBytes })
    }

    events.push({ kind: 'chunk', path: open.path, text })
  }

  private commitOpenFile(open: OpenFile, events: ParseEvent[]): void {
    const content = Buffer.from(open.pieces.join(''), 'utf8')
    this.files.push({ path: open.path, content })
    this.open = undefined
    events.push({ kind: 'file_end', path: open.path, bytes: content.byteLength })
  }

  /**
   * Runs the real validator over the paths committed so far plus this one, with empty contents.
   * `ENTRY_MISSING` is the one outcome ignored mid-stream: `index.html` may still be coming.
   */
  private assertPathAcceptable(path: string): void {
    const probe: BundleFile[] = [
      ...this.files.map((file) => ({ path: file.path, content: EMPTY_CONTENT })),
      { path, content: EMPTY_CONTENT },
    ]

    const validation = validateBundle(probe, this.limits)
    if (!validation.ok && validation.code !== 'ENTRY_MISSING') {
      throw parseError(validation.code, validation.details)
    }
  }
}
