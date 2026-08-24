import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

import { baseUrlFor } from '../../../push-core/src/index.ts'
import { saveToken } from '../credentials.ts'
import { USER_AGENT } from '../version.ts'

/**
 * Every scope the CLI needs across all its commands. `login` probes a read endpoint to validate
 * the token, so a write-only token cannot even sign in — the instruction and the probe have to
 * agree or onboarding dead-ends on a 403.
 */
const REQUIRED_SCOPES = ['artifacts:read', 'artifacts:write', 'shares:write'] as const

/** Matches `api-client.ts`: the probe carries metadata only, and Node's `fetch` waits forever. */
const PROBE_TIMEOUT_MS = 30_000

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

  process.stderr.write(promptText)
  const reader = createInterface({ input: process.stdin, output: discardEcho, terminal: true })

  const redrawMask = (_character: string, key: { name?: string } | undefined): void => {
    if (key?.name === 'return' || key?.name === 'enter') return
    if (process.stderr.isTTY !== true) return
    const width = (reader as unknown as { line: string }).line.length
    process.stderr.write(`\r${promptText}${'*'.repeat(width)}${ESCAPE}[K`)
  }
  process.stdin.on('keypress', redrawMask)

  return new Promise<string>((resolve) => {
    let isSettled = false
    const finish = (answer: string): void => {
      if (isSettled) return
      isSettled = true
      process.stdin.off('keypress', redrawMask)
      reader.close()
      process.stderr.write('\n')
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

type TokenSource = 'flag' | 'environment' | 'prompt'

async function probe(
  baseUrl: string,
  token: string,
  host: string,
): Promise<Response | null> {
  try {
    return await fetch(`${baseUrl}/api/v1/artifacts?limit=1`, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch {
    process.stderr.write(`could not reach ${host}\n`)
    return null
  }
}

function handleRedirect(response: Response, host: string): boolean {
  if (response.status >= 300 && response.status < 400) {
    process.stderr.write(`${host} redirected the API probe — is that the right host?\n`)
    return true
  }
  return false
}

/** Returns the exit code for a probe the CLI cannot proceed from, or null when the token is good. */
function classifyProbeFailure(response: Response, host: string): number | null {
  if (handleRedirect(response, host)) return 1
  if (response.status === 401) {
    process.stderr.write('that token was rejected\n')
    return 1
  }
  if (response.status === 403) {
    process.stderr.write(`that token is missing a scope — it needs ${REQUIRED_SCOPES.join(', ')}\n`)
    return 1
  }
  if (response.status !== 200) {
    process.stderr.write(`the server returned ${String(response.status)}\n`)
    return 1
  }
  return null
}

interface TokenResolution {
  token: string
  source: TokenSource
}

/**
 * `--token` is authoritative whenever it's supplied at all — an empty value is a caller error, not
 * a signal to fall through to ENCLAVE_TOKEN or the prompt.
 */
async function resolveToken(token: string | undefined): Promise<TokenResolution | number> {
  if (token !== undefined) {
    if (token === '') {
      process.stderr.write('no token was entered\n')
      return 1
    }
    return { token, source: 'flag' }
  }

  const fromEnvironment = process.env['ENCLAVE_TOKEN']?.trim()
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    // --help promises ENCLAVE_TOKEN works; prompting anyway dead-ends CI, which has no TTY to answer.
    return { token: fromEnvironment, source: 'environment' }
  }

  const prompted = await readSecret('Token: ')
  if (prompted === '') {
    process.stderr.write('no token was entered\n')
    return 1
  }
  return { token: prompted, source: 'prompt' }
}

/** A 403 means the environment token authenticated but lacks a scope, so it says so instead of "rejected". */
async function recoverFromEnvironmentToken(
  rejectionStatus: number,
  baseUrl: string,
  host: string,
): Promise<number> {
  if (rejectionStatus === 403) {
    process.stderr.write(
      `that token is missing a scope — it needs ${REQUIRED_SCOPES.join(', ')}; ` +
        'enter a token to store instead, or unset ENCLAVE_TOKEN and retry\n',
    )
  } else {
    process.stderr.write(
      `ENCLAVE_TOKEN was rejected by ${host} — enter a token to store instead, or unset ENCLAVE_TOKEN and retry\n`,
    )
  }

  const secondToken = await readSecret('Token: ')
  if (secondToken === '') {
    process.stderr.write('no token was entered\n')
    return 1
  }

  const response = await probe(baseUrl, secondToken, host)
  if (response === null) return 1

  const failureCode = classifyProbeFailure(response, host)
  if (failureCode !== null) return failureCode

  return saveTokenFromValidResponse(response, host, secondToken)
}

async function saveTokenFromValidResponse(
  response: Response,
  host: string,
  token: string,
): Promise<number> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    process.stderr.write(
      'server response was not an enclave artifacts list — is that the right host?\n',
    )
    return 1
  }
  if (!isArtifactsListEnvelope(body)) {
    process.stderr.write(
      'server response was not an enclave artifacts list — is that the right host?\n',
    )
    return 1
  }
  saveToken(host, token)
  process.stdout.write(`✓ logged in to ${host}\n`)
  return 0
}

export async function runLogin(
  host: string,
  token?: string,
  isInsecureAllowed = false,
): Promise<number> {
  const baseUrl = baseUrlFor(host, isInsecureAllowed)
  process.stderr.write(`Create a token at ${baseUrl}/settings/tokens\n`)
  process.stderr.write(`Scopes: ${REQUIRED_SCOPES.join(', ')}\n`)

  const resolution = await resolveToken(token)
  if (typeof resolution === 'number') return resolution
  const { token: resolvedToken, source } = resolution

  const response = await probe(baseUrl, resolvedToken, host)
  if (response === null) return 1

  // Recovery path: when an environment token is rejected on a TTY, prompt for a replacement.
  if (
    (response.status === 401 || response.status === 403) &&
    source === 'environment' &&
    process.stdin.isTTY
  ) {
    return recoverFromEnvironmentToken(response.status, baseUrl, host)
  }

  const failureCode = classifyProbeFailure(response, host)
  if (failureCode !== null) return failureCode

  return saveTokenFromValidResponse(response, host, resolvedToken)
}

function isArtifactsListEnvelope(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || !('data' in body)) return false
  const data = (body as { data: unknown }).data
  if (typeof data !== 'object' || data === null || !('items' in data)) return false
  return Array.isArray((data as { items: unknown }).items)
}
