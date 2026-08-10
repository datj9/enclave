import type { Writable } from 'node:stream'

interface ErrorWithCode {
  readonly code?: unknown
}

/**
 * `enclave list | head -1` closes stdout while the CLI is still writing. Node raises EPIPE on the
 * stream, and an unhandled `error` event on a stream is a crash — a 1200-byte stack trace for what
 * every other command-line tool treats as "the reader has seen enough".
 */
export function ignoreBrokenPipe(stream: Writable): void {
  stream.on('error', (error: unknown) => {
    if ((error as ErrorWithCode).code === 'EPIPE') return
    throw error
  })
}
