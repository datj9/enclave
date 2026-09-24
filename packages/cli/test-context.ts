import type { CliContext, OutputStream } from './src/output.ts'

/** A stream that remembers everything written to it. */
export interface CapturedStream extends OutputStream {
  text(): string
  /** Each write on its own, for assertions about how output was framed rather than what it says. */
  chunks(): readonly string[]
  clear(): void
}

export function capturedStream(isTTY?: boolean): CapturedStream {
  const chunks: string[] = []
  return {
    ...(isTTY === undefined ? {} : { isTTY }),
    write(chunk: string): boolean {
      chunks.push(chunk)
      return true
    },
    text(): string {
      return chunks.join('')
    },
    chunks(): readonly string[] {
      return [...chunks]
    },
    clear(): void {
      chunks.length = 0
    },
  }
}

/**
 * The context a command runs in, with buffers in place of the process streams and a private
 * environment the test owns outright — nothing leaks into `process.env`, so there is nothing to
 * restore afterwards.
 */
export interface TestContext extends CliContext {
  readonly stdout: CapturedStream
  readonly stderr: CapturedStream
  readonly env: Record<string, string | undefined>
}

export function testContext(env: Record<string, string | undefined> = {}): TestContext {
  return { stdout: capturedStream(), stderr: capturedStream(), env: { ...env } }
}
