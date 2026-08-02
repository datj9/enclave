import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readCredentials } from './src/credentials.ts'
import { runLogin } from './src/commands/login.ts'

/**
 * readline reads the token from a real stdin, which a test cannot supply. Faking the interface is
 * what makes the surrounding flow — the scope instruction, the probe, the failure branches —
 * testable at all. `login.ts` shipped a self-contradicting scope instruction precisely because
 * nothing here exercised it.
 */
let answer = ''

const { createInterfaceMock } = vi.hoisted(() => ({
  createInterfaceMock: vi.fn(() => ({
    question: (_prompt: string, callback: (value: string) => void) => {
      callback(answer)
    },
    close: () => undefined,
    once: () => undefined,
  })),
}))

vi.mock('node:readline', () => ({
  createInterface: createInterfaceMock,
}))

const HOST = 'enclave.example.com'

let configDirectory: string
let originalConfigHome: string | undefined
let written: string[]

function stdout(): string {
  return written.join('')
}

function respondWith(status: number): void {
  globalThis.fetch = vi.fn(async () =>
    Promise.resolve(new Response(status === 200 ? '{"items":[]}' : '{}', { status })),
  ) as typeof fetch
}

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), 'enclave-login-'))
  originalConfigHome = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = configDirectory

  answer = 'enc_a_valid_looking_token'
  written = []
  createInterfaceMock.mockClear()
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = originalConfigHome
  rmSync(configDirectory, { recursive: true, force: true })
})

describe('runLogin', () => {
  it('names every scope the CLI needs, not only artifacts:write', async () => {
    respondWith(200)
    await runLogin(HOST)

    // The probe reads, so an artifacts:write-only token 403s. Instruction and probe must agree.
    expect(stdout()).toContain('artifacts:read')
    expect(stdout()).toContain('artifacts:write')
    expect(stdout()).toContain('shares:write')
  })

  it('points at the token page on the resolved base url', async () => {
    respondWith(200)
    await runLogin(HOST)

    expect(stdout()).toContain(`https://${HOST}/settings/tokens`)
  })

  it('saves the token and returns 0 when the probe succeeds', async () => {
    respondWith(200)

    expect(await runLogin(HOST)).toBe(0)
    expect(readCredentials()[HOST]?.token).toBe('enc_a_valid_looking_token')
  })

  it('probes a read endpoint with the token as a bearer header', async () => {
    respondWith(200)
    await runLogin(HOST)

    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(call?.[0]).toBe(`https://${HOST}/api/v1/artifacts?limit=1`)
    expect((call?.[1]?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer enc_a_valid_looking_token',
    )
  })

  it('explains which scopes are missing on 403 rather than printing a bare status', async () => {
    respondWith(403)

    expect(await runLogin(HOST)).toBe(1)
    expect(stdout()).toContain('missing a scope')
    expect(stdout()).not.toContain('the server returned 403')
    expect(readCredentials()[HOST]).toBeUndefined()
  })

  it('reports a rejected token on 401 and saves nothing', async () => {
    respondWith(401)

    expect(await runLogin(HOST)).toBe(1)
    expect(stdout()).toContain('rejected')
    expect(readCredentials()[HOST]).toBeUndefined()
  })

  it('reports an unreachable host and saves nothing', async () => {
    globalThis.fetch = vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch

    expect(await runLogin(HOST)).toBe(1)
    expect(stdout()).toContain('could not reach')
    expect(readCredentials()[HOST]).toBeUndefined()
  })

  it('refuses an empty token without contacting the server', async () => {
    respondWith(200)
    answer = '   '

    expect(await runLogin(HOST)).toBe(1)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(readCredentials()[HOST]).toBeUndefined()
  })

  it('never writes the token to stdout', async () => {
    respondWith(200)
    await runLogin(HOST)

    expect(stdout()).not.toContain('enc_a_valid_looking_token')
  })

  it('probes the exact single-scheme url for a host that already carries one', async () => {
    respondWith(200)
    await runLogin('http://127.0.0.1:3000')

    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(call?.[0]).toBe('http://127.0.0.1:3000/api/v1/artifacts?limit=1')
    expect(stdout()).toContain('Create a token at http://127.0.0.1:3000/settings/tokens')
  })

  it('skips the prompt and uses the given token when --token is supplied', async () => {
    respondWith(200)

    expect(await runLogin(HOST, 'enc_from_the_flag')).toBe(0)
    expect(createInterfaceMock).not.toHaveBeenCalled()
    expect(readCredentials()[HOST]?.token).toBe('enc_from_the_flag')

    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    expect((call?.[1]?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer enc_from_the_flag',
    )
  })
})

describe('runLogin with a real stdin close', () => {
  let originalStdin: typeof process.stdin

  beforeEach(() => {
    originalStdin = process.stdin
    written = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
  })

  /**
   * The other tests fake `node:readline` entirely, which hides the exact defect: `question`'s
   * callback never fires on EOF. This test uses the real readline against a real stream so the
   * close path — not the stub's synchronous callback — is what settles the promise.
   */
  it('resolves instead of hanging when stdin closes with no input', async () => {
    vi.doUnmock('node:readline')
    vi.resetModules()
    const { runLogin: runLoginWithRealReadline } = await import('./src/commands/login.ts')

    const fakeStdin = new PassThrough()
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })

    respondWith(200)
    const resultPromise = runLoginWithRealReadline('http://127.0.0.1:3000')
    fakeStdin.end()

    await expect(resultPromise).resolves.toBe(1)
    expect(stdout()).toContain('no token was entered')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('runLogin masking a real stdin', () => {
  let originalStdin: typeof process.stdin
  let originalIsTTY: PropertyDescriptor | undefined

  beforeEach(() => {
    originalStdin = process.stdin
    originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    written = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true })
    if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
  })

  async function loginTyping(keystrokes: string): Promise<number> {
    vi.doUnmock('node:readline')
    vi.resetModules()
    const { runLogin: runLoginWithRealReadline } = await import('./src/commands/login.ts')

    const fakeStdin = new PassThrough()
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })

    respondWith(200)
    const resultPromise = runLoginWithRealReadline('http://127.0.0.1:3000')
    for (const chunk of keystrokes) fakeStdin.write(chunk)
    fakeStdin.write('\r')
    return resultPromise
  }

  it('emits a real ESC byte before [K rather than the literal characters', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

    await loginTyping('abc')

    expect(stdout()).toContain('\x1b[K')
  })

  it('renders a mask width that tracks the real buffer, not a stale keypress count', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

    // Ctrl-U clears the buffer entirely; the old code kept counting keypresses regardless.
    const result = await loginTyping('abcdef\x15xy')

    expect(result).toBe(0)
    const maskFrames = written.filter((chunk) => chunk.startsWith('\rToken: '))
    expect(maskFrames).toContain('\rToken: \x1b[K')
    expect(maskFrames[maskFrames.length - 1]).toBe(`\rToken: ${'*'.repeat(2)}\x1b[K`)
  })

  it('writes no mask and no escape codes when stdout is not a TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true })

    await loginTyping('abc')

    expect(written.some((chunk) => chunk.includes('*'))).toBe(false)
    expect(written.some((chunk) => chunk.includes('\x1b'))).toBe(false)
  })
})
