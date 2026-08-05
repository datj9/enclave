import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { credentialsPath, saveToken } from './src/credentials.ts'
import { runLogout } from './src/commands/logout.ts'

const HOST = 'enclave.example.com'

let configDirectory: string
let originalConfigHome: string | undefined
let written: string[]
let writtenToStderr: string[]

function stdout(): string {
  return written.join('')
}

function stderrOutput(): string {
  return writtenToStderr.join('')
}

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), 'enclave-logout-'))
  originalConfigHome = process.env['XDG_CONFIG_HOME']
  process.env['XDG_CONFIG_HOME'] = configDirectory

  written = []
  writtenToStderr = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writtenToStderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = originalConfigHome
  rmSync(configDirectory, { recursive: true, force: true })
})

describe('runLogout', () => {
  it('reports success on stdout when a credential is forgotten', () => {
    saveToken(HOST, 'enc_a_valid_looking_token')

    expect(runLogout(HOST)).toBe(0)
    expect(stdout()).toContain(`✓ forgot ${HOST}`)
    expect(stderrOutput()).toBe('')
  })

  it('reports a missing credential on stderr, not stdout', () => {
    expect(runLogout(HOST)).toBe(0)
    expect(stderrOutput()).toContain(`no credential for ${HOST}`)
    expect(stdout()).toBe('')
  })

  it('reports a corrupt credentials file on stderr instead of throwing a stack trace', () => {
    saveToken(HOST, 'enc_a_valid_looking_token')
    writeFileSync(credentialsPath(), '{ not json', { mode: 0o600 })

    expect(runLogout(HOST)).toBe(1)
    expect(stderrOutput()).toContain('remove it and log in again')
    expect(stdout()).toBe('')
  })
})
