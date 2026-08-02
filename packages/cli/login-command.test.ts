import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, callback: (value: string) => void) => {
      callback(answer)
    },
    close: () => undefined,
  }),
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
})
