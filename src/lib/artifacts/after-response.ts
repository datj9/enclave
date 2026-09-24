import { after } from 'next/server'

/**
 * Runs best-effort follow-up work (today: auto-classification) after the response has been sent,
 * so an upload's latency no longer includes an LLM round-trip of up to `CLASSIFY_TIMEOUT_MS`.
 *
 * `after()` only works inside a Next.js request scope; it throws synchronously anywhere else —
 * a CLI job, a script, or a test that calls the library directly. There is no response to get
 * out of the way of in those contexts, so the task runs inline and is awaited: a script that
 * exits right after `createArtifactWithBundle` resolves must not lose the work, and the
 * integration suites keep observing the tags as soon as the call returns.
 *
 * The task's own failures are logged, never rethrown: the write it follows has already
 * committed, and in the `after()` path there is no caller left to report to anyway.
 */
export async function runAfterResponse(label: string, task: () => Promise<unknown>): Promise<void> {
  const guarded = async (): Promise<void> => {
    try {
      await task()
    } catch (error) {
      console.warn(`[after-response] ${label} failed:`, error)
    }
  }

  try {
    after(guarded)
    return
  } catch {
    // Outside a request scope: fall through and run inline.
  }

  await guarded()
}
