#!/usr/bin/env node
import { EXIT_FAILED } from './exit-codes.ts'
import { main } from './main.ts'
import { messageOf, processContext } from './output.ts'
import { ignoreBrokenPipe } from './streams.ts'

ignoreBrokenPipe(process.stdout)
ignoreBrokenPipe(process.stderr)

/**
 * `process.exitCode` rather than `process.exit()`: exiting outright can truncate stdout when it is
 * a pipe, which would cut off the JSON a `--json` caller is reading.
 */
main(process.argv.slice(2), processContext())
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${messageOf(error)}\n`)
    process.exitCode = EXIT_FAILED
  })
