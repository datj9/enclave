import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * `runAfterResponse` has two paths: inside a Next.js request it hands the task to `after()` and
 * returns at once; anywhere else `after()` throws and the task runs inline. The first suite uses
 * the real `next/server` to pin the second path — if a Next upgrade ever made `after()` silently
 * no-op outside a request, scripts would start dropping classification without a trace.
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('next/server')
  vi.resetModules()
})

describe('runAfterResponse · outside a request scope (real next/server)', () => {
  it('runs the task inline and awaits it', async () => {
    const { runAfterResponse } = await import('@/lib/artifacts/after-response')
    const order: string[] = []

    await runAfterResponse('inline', async () => {
      await Promise.resolve()
      order.push('task')
    })
    order.push('returned')

    expect(order).toEqual(['task', 'returned'])
  })

  it('logs a failing task instead of rethrowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { runAfterResponse } = await import('@/lib/artifacts/after-response')

    await expect(
      runAfterResponse('boom', () => Promise.reject(new Error('provider down'))),
    ).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith('[after-response] boom failed:', expect.any(Error))
  })
})

describe('runAfterResponse · inside a request scope', () => {
  it('defers the task to after() and returns without running it', async () => {
    const scheduled: (() => Promise<void>)[] = []
    vi.doMock('next/server', () => ({
      after: (task: () => Promise<void>) => {
        scheduled.push(task)
      },
    }))
    const { runAfterResponse } = await import('@/lib/artifacts/after-response')
    const task = vi.fn(() => Promise.resolve())

    await runAfterResponse('deferred', task)

    expect(task).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)

    await scheduled[0]?.()
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('keeps a deferred failure inside the log, off the response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const scheduled: (() => Promise<void>)[] = []
    vi.doMock('next/server', () => ({
      after: (task: () => Promise<void>) => {
        scheduled.push(task)
      },
    }))
    const { runAfterResponse } = await import('@/lib/artifacts/after-response')

    await runAfterResponse('deferred-boom', () => Promise.reject(new Error('timeout')))
    await expect(scheduled[0]?.()).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith('[after-response] deferred-boom failed:', expect.any(Error))
  })
})
