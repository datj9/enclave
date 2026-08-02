import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

import { baseUrlFor } from '../../../push-core/src/index.ts'
import { saveToken } from '../credentials.ts'

/**
 * Every scope the CLI needs across all its commands. `login` probes a read endpoint to validate
 * the token, so a write-only token cannot even sign in — the instruction and the probe have to
 * agree or onboarding dead-ends on a 403.
 */
const REQUIRED_SCOPES = ['artifacts:read', 'artifacts:write', 'shares:write'] as const

const ESCAPE = '\x1b'

/**
 * `terminal: true` puts stdin in raw mode, which disables the terminal's own echo — drawing
 * nothing back reads as a hung CLI, so this redraws a `*` mask on every keypress instead. The mask
 * width is read from readline's own `.line`, which is already updated by the time `keypress`
 * fires (verified against Node's readline implementation) — tracking keystrokes independently
 * drifts from the buffer on Ctrl-U, arrow keys, Home/End and Del.
 */
function readSecret(promptText: string): Promise<string> {
  const discardEcho = new Writable({
    write(_chunk: unknown, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      done()
    },
  })

  process.stdout.write(promptText)
  const reader = createInterface({ input: process.stdin, output: discardEcho, terminal: true })

  const redrawMask = (_character: string, key: { name?: string } | undefined): void => {
    if (key?.name === 'return' || key?.name === 'enter') return
    if (process.stdout.isTTY !== true) return
    const width = (reader as unknown as { line: string }).line.length
    process.stdout.write(`\r${promptText}${'*'.repeat(width)}${ESCAPE}[K`)
  }
  process.stdin.on('keypress', redrawMask)

  return new Promise<string>((resolve) => {
    let isSettled = false
    const finish = (answer: string): void => {
      if (isSettled) return
      isSettled = true
      process.stdin.off('keypress', redrawMask)
      reader.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    }
    // Ctrl-D (stdin closed with no input) never fires `question`'s callback, so without this the
    // promise never settles and the CLI exits 0 having logged nobody in.
    reader.once('close', () => {
      finish('')
    })
    reader.question('', finish)
  })
}

export async function runLogin(
  host: string,
  token?: string,
  isInsecureAllowed = false,
): Promise<number> {
  const baseUrl = baseUrlFor(host, isInsecureAllowed)
  process.stdout.write(`Create a token at ${baseUrl}/settings/tokens\n`)
  process.stdout.write(`Scopes: ${REQUIRED_SCOPES.join(', ')}\n`)

  const resolvedToken = token ?? (await readSecret('Token: '))
  if (resolvedToken === '') {
    process.stdout.write('no token was entered\n')
    return 1
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/v1/artifacts?limit=1`, {
      headers: { authorization: `Bearer ${resolvedToken}` },
    })
  } catch {
    process.stdout.write(`could not reach ${host}\n`)
    return 1
  }

  if (response.status === 401) {
    process.stdout.write('that token was rejected\n')
    return 1
  }
  // The probe reads, so a write-only token lands here rather than on 401. Naming the scope the
  // server refused is the difference between a one-line fix and an unexplained failure.
  if (response.status === 403) {
    process.stdout.write(`that token is missing a scope — it needs ${REQUIRED_SCOPES.join(', ')}\n`)
    return 1
  }
  if (response.status !== 200) {
    process.stdout.write(`the server returned ${String(response.status)}\n`)
    return 1
  }

  saveToken(host, resolvedToken)
  process.stdout.write(`✓ logged in to ${host}\n`)
  return 0
}
