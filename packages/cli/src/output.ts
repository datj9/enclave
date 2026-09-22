import type { SkippedFile, SkipReason } from '../../push-core/src/index.ts'

/** The slice of a stream the CLI writes through — a `process` stream in production, a buffer in tests. */
export interface OutputStream {
  write(chunk: string): unknown
  readonly isTTY?: boolean
}

export type Environment = Readonly<Record<string, string | undefined>>

/**
 * Everything a command reads from or writes to the outside world, handed in rather than reached
 * for. Commands that wrote to `process.stdout` directly could only be tested by spying on the
 * global streams, which is how a stray write to the wrong one used to go unnoticed.
 */
export interface CliContext {
  readonly stdout: OutputStream
  readonly stderr: OutputStream
  readonly env: Environment
}

export function processContext(): CliContext {
  return { stdout: process.stdout, stderr: process.stderr, env: process.env }
}

/** A result line — stdout is the contract a script reads. */
export function printLine(ctx: Pick<CliContext, 'stdout'>, text: string): void {
  ctx.stdout.write(`${text}\n`)
}

/**
 * `indent` is per command because the shapes are pinned: `list`/`show`/… have always printed
 * pretty JSON and `push`/`share` a single line, and a script may be reading either way.
 */
export function printJson(ctx: Pick<CliContext, 'stdout'>, value: unknown, indent?: number): void {
  ctx.stdout.write(`${JSON.stringify(value, null, indent)}\n`)
}

/**
 * Diagnostics, warnings and progress go to stderr, never stdout. `--json` promises stdout carries
 * the result object and nothing else, so a human line printed there turns `… --json | jq` into a
 * parse error instead of a diagnosable failure.
 */
export function printDiagnostic(ctx: Pick<CliContext, 'stderr'>, text: string): void {
  ctx.stderr.write(`${text}\n`)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A Record, not a list: a new SkipReason breaks this literal instead of falling through
 *  to `[object Object]`. */
const SKIP_REASONS: Readonly<Record<SkipReason, true>> = {
  unsupported_extension: true,
  invalid_path: true,
  ignored: true,
  too_large: true,
}

export function isSkippedFile(value: unknown): value is SkippedFile {
  if (typeof value !== 'object' || value === null) return false
  const { path, reason } = value as { path?: unknown; reason?: unknown }
  return (
    typeof path === 'string' && typeof reason === 'string' && Object.hasOwn(SKIP_REASONS, reason)
  )
}

export function skipReasonText(file: SkippedFile): string {
  switch (file.reason) {
    case 'unsupported_extension': {
      const fileName = file.path.slice(file.path.lastIndexOf('/') + 1)
      const dotIndex = fileName.lastIndexOf('.')
      return `unsupported (${dotIndex > 0 ? fileName.slice(dotIndex) : ''})`
    }
    case 'invalid_path':
      return 'invalid path'
    case 'ignored':
      return 'ignored'
    case 'too_large':
      return 'too large'
  }
}

/**
 * `String(value)` on the skipped array yields `[object Object]`, destroying the one fact that
 * explains the refusal. Null means the detail has nothing to say, so its line is dropped rather
 * than printed empty.
 */
function detailText(value: unknown): string | null {
  if (!Array.isArray(value)) return String(value)
  if (value.length === 0) return null
  return value
    .map((entry: unknown) =>
      isSkippedFile(entry) ? `${entry.path} (${skipReasonText(entry)})` : String(entry),
    )
    .join(', ')
}

/** `key=value key=value`, or null when no detail has anything to say. */
export function renderDetails(details: Readonly<Record<string, unknown>>): string | null {
  const rendered = Object.entries(details)
    .flatMap(([key, value]) => {
      const text = detailText(value)
      return text === null ? [] : [`${key}=${text}`]
    })
    .join(' ')
  return rendered === '' ? null : rendered
}
