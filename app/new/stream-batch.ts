import type { Action } from './use-generation'

/**
 * A model streams dozens of `chunk` frames a second, and dispatching each one re-rendered the whole
 * composer per frame. Chunks are instead queued and flushed once per animation frame — the screen
 * cannot show more than one update a frame anyway — and consecutive chunks for the same file are
 * merged at push time, so the reducer concatenates one string per file per frame instead of one per
 * token.
 *
 * Every other action (`file_start`, `file_end`, `done`, `error`, `cancelled`) flushes the queue
 * first and is dispatched immediately: order is preserved, and the per-file checkmark, the result
 * panel, and the failure never wait on a frame that a background tab may not paint.
 */

export interface FrameScheduler {
  readonly request: (callback: () => void) => number
  readonly cancel: (handle: number) => void
}

export interface ActionBatcher {
  readonly push: (action: Action) => void
  /** Dispatches everything queued, synchronously. Call before a terminal dispatch or on exit. */
  readonly flush: () => void
  /** Drops a pending frame and anything queued without dispatching — teardown only. */
  readonly dispose: () => void
}

/**
 * `requestAnimationFrame` where there is one. A hidden tab stops painting frames, which is
 * harmless here: the queue coalesces while it waits, and the next non-chunk action flushes it.
 */
export function animationFrameScheduler(): FrameScheduler {
  if (typeof requestAnimationFrame === 'function') {
    return {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    }
  }
  return {
    request: (callback) => setTimeout(callback, 16) as unknown as number,
    cancel: (handle) => clearTimeout(handle),
  }
}

export function createActionBatcher(
  dispatch: (action: Action) => void,
  scheduler: FrameScheduler = animationFrameScheduler(),
): ActionBatcher {
  let queue: Action[] = []
  let frame: number | null = null

  function flush(): void {
    if (frame !== null) {
      scheduler.cancel(frame)
      frame = null
    }
    if (queue.length === 0) return
    const pending = queue
    queue = []
    // React batches every dispatch made in one task into a single render.
    for (const action of pending) dispatch(action)
  }

  function push(action: Action): void {
    if (action.type !== 'chunk') {
      flush()
      dispatch(action)
      return
    }

    const last = queue.at(-1)
    if (last?.type === 'chunk' && last.path === action.path) {
      queue[queue.length - 1] = { ...last, text: last.text + action.text }
    } else {
      queue.push(action)
    }

    frame ??= scheduler.request(() => {
      frame = null
      flush()
    })
  }

  function dispose(): void {
    if (frame !== null) scheduler.cancel(frame)
    frame = null
    queue = []
  }

  return { push, flush, dispose }
}
