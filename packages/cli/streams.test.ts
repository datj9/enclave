import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { ignoreBrokenPipe } from './src/streams.ts'

function errorWith(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code)
  error.code = code
  return error
}

describe('ignoreBrokenPipe', () => {
  it('swallows EPIPE so a closed reader is not a crash', () => {
    const stream = new PassThrough()
    ignoreBrokenPipe(stream)

    expect(() => stream.emit('error', errorWith('EPIPE'))).not.toThrow()
  })

  it('still surfaces an error that is not a closed pipe', () => {
    const stream = new PassThrough()
    ignoreBrokenPipe(stream)

    expect(() => stream.emit('error', errorWith('ENOSPC'))).toThrow('ENOSPC')
  })
})
