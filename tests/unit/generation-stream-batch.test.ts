import { describe, expect, it } from 'vitest'

import { createActionBatcher, type FrameScheduler } from '@app/new/stream-batch'
import type { Action } from '@app/new/use-generation'

/** A frame scheduler the test advances by hand, standing in for requestAnimationFrame. */
function manualScheduler() {
  let nextHandle = 1
  const pending = new Map<number, () => void>()
  const scheduler: FrameScheduler = {
    request(callback) {
      const handle = nextHandle++
      pending.set(handle, callback)
      return handle
    },
    cancel(handle) {
      pending.delete(handle)
    },
  }
  return {
    scheduler,
    pendingFrames: () => pending.size,
    runFrame() {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const callback of callbacks) callback()
    },
  }
}

function setup() {
  const dispatched: Action[] = []
  const frames = manualScheduler()
  const batcher = createActionBatcher((action) => dispatched.push(action), frames.scheduler)
  return { dispatched, frames, batcher }
}

const chunk = (path: string, text: string): Action => ({ type: 'chunk', path, text })

describe('createActionBatcher', () => {
  it('holds chunks until the next frame, then dispatches them merged', () => {
    const { dispatched, frames, batcher } = setup()

    batcher.push(chunk('index.html', '<h'))
    batcher.push(chunk('index.html', '1>'))
    batcher.push(chunk('index.html', 'hi'))

    expect(dispatched).toEqual([])
    expect(frames.pendingFrames()).toBe(1)

    frames.runFrame()

    expect(dispatched).toEqual([chunk('index.html', '<h1>hi')])
  })

  it('requests one frame per batch, not one per chunk', () => {
    const { frames, batcher } = setup()

    for (let index = 0; index < 50; index++) batcher.push(chunk('a.js', 'x'))

    expect(frames.pendingFrames()).toBe(1)
  })

  it('keeps chunks for different files apart and in order', () => {
    const { dispatched, frames, batcher } = setup()

    batcher.push(chunk('a.js', '1'))
    batcher.push(chunk('a.js', '2'))
    batcher.push(chunk('b.css', '3'))
    batcher.push(chunk('a.js', '4'))
    frames.runFrame()

    expect(dispatched).toEqual([chunk('a.js', '12'), chunk('b.css', '3'), chunk('a.js', '4')])
  })

  it('flushes queued chunks before a non-chunk action and dispatches it at once', () => {
    const { dispatched, frames, batcher } = setup()

    batcher.push(chunk('index.html', 'abc'))
    batcher.push({ type: 'file_end', path: 'index.html', bytes: 3 })

    expect(dispatched).toEqual([
      chunk('index.html', 'abc'),
      { type: 'file_end', path: 'index.html', bytes: 3 },
    ])
    // The frame that would have flushed the chunk is cancelled — nothing left to do.
    expect(frames.pendingFrames()).toBe(0)
  })

  it('dispatches file_start immediately so the panel appears without waiting a frame', () => {
    const { dispatched, batcher } = setup()

    batcher.push({ type: 'file_start', path: 'index.html' })

    expect(dispatched).toEqual([{ type: 'file_start', path: 'index.html' }])
  })

  it('flush() empties the queue synchronously, for the exit paths', () => {
    const { dispatched, frames, batcher } = setup()

    batcher.push(chunk('index.html', 'tail'))
    batcher.flush()

    expect(dispatched).toEqual([chunk('index.html', 'tail')])
    expect(frames.pendingFrames()).toBe(0)

    batcher.flush()
    expect(dispatched).toHaveLength(1)
  })

  it('dispose() drops the pending frame and queue without dispatching', () => {
    const { dispatched, frames, batcher } = setup()

    batcher.push(chunk('index.html', 'never shown'))
    batcher.dispose()
    frames.runFrame()

    expect(dispatched).toEqual([])
    expect(frames.pendingFrames()).toBe(0)
  })

  it('starts a fresh batch after a frame has run', () => {
    const { dispatched, frames, batcher } = setup()

    batcher.push(chunk('a.js', '1'))
    frames.runFrame()
    batcher.push(chunk('a.js', '2'))
    frames.runFrame()

    expect(dispatched).toEqual([chunk('a.js', '1'), chunk('a.js', '2')])
  })
})
