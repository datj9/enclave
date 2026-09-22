import { forgetToken } from '../credentials.ts'
import { reportFailure } from '../errors.ts'
import { EXIT_OK, type ExitCode } from '../exit-codes.ts'
import { printDiagnostic, printLine, type CliContext } from '../output.ts'

/**
 * Exits 0 when there was no credential to forget: the end state the caller asked for — no token
 * stored for this host — already holds, so a cleanup script can run `logout` unconditionally. The
 * note goes to stderr so it is visible without reading as a result.
 */
export function runLogout(host: string, ctx: CliContext): ExitCode {
  try {
    if (forgetToken(host, ctx.env)) {
      printLine(ctx, `✓ forgot ${host}`)
      return EXIT_OK
    }
  } catch (error) {
    // `logout` takes no --json: it has no object to return.
    return reportFailure(error, ctx, { isJson: false, host })
  }
  printDiagnostic(ctx, `no credential for ${host}`)
  return EXIT_OK
}
