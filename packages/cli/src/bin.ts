#!/usr/bin/env node
import { main } from './main.ts'
import { ignoreBrokenPipe } from './streams.ts'

ignoreBrokenPipe(process.stdout)
ignoreBrokenPipe(process.stderr)

/**
 * `process.exitCode` rather than `process.exit()`: exiting outright can truncate stdout when it is
 * a pipe, which would cut off the JSON a `--json` caller is reading.
 */
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
