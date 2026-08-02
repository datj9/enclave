import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

import { baseUrlFor } from '../../../push-core/src/index.ts'
import { saveToken } from '../credentials.ts'

/** readline echoes what it reads; sending that echo nowhere is what keeps the token off screen. */
function readSecret(promptText: string): Promise<string> {
  const discardEcho = new Writable({
    write(_chunk: unknown, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
      done()
    },
  })

  process.stdout.write(promptText)
  const reader = createInterface({
    input: process.stdin,
    output: discardEcho,
    terminal: true,
  })

  return new Promise<string>((resolve) => {
    reader.question('', (answer) => {
      reader.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

export async function runLogin(host: string): Promise<number> {
  const baseUrl = baseUrlFor(host)
  process.stdout.write(`Create a token with scope artifacts:write at ${baseUrl}/settings/tokens\n`)

  const token = await readSecret('Token: ')
  if (token === '') {
    process.stdout.write('no token was entered\n')
    return 1
  }

  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/v1/artifacts?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    })
  } catch {
    process.stdout.write(`could not reach ${host}\n`)
    return 1
  }

  if (response.status === 401) {
    process.stdout.write('that token was rejected\n')
    return 1
  }
  if (response.status !== 200) {
    process.stdout.write(`the server returned ${String(response.status)}\n`)
    return 1
  }

  saveToken(host, token)
  process.stdout.write(`✓ logged in to ${host}\n`)
  return 0
}
