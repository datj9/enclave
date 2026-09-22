import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { credentialsPath, saveToken } from './src/credentials.ts'
import { runLogout } from './src/commands/logout.ts'
import { testContext, type TestContext } from './test-context.ts'

const HOST = 'enclave.example.com'

let configDirectory: string
let ctx: TestContext

function stdout(): string {
  return ctx.stdout.text()
}

function stderrOutput(): string {
  return ctx.stderr.text()
}

beforeEach(() => {
  configDirectory = mkdtempSync(join(tmpdir(), 'enclave-logout-'))
  ctx = testContext({ XDG_CONFIG_HOME: configDirectory })
})

afterEach(() => {
  rmSync(configDirectory, { recursive: true, force: true })
})

describe('runLogout', () => {
  it('reports success on stdout when a credential is forgotten', () => {
    saveToken(HOST, 'enc_a_valid_looking_token', ctx.env)

    expect(runLogout(HOST, ctx)).toBe(0)
    expect(stdout()).toContain(`✓ forgot ${HOST}`)
    expect(stderrOutput()).toBe('')
  })

  // Documented contract: the state the caller asked for already holds, so cleanup scripts can run
  // `logout` unconditionally without special-casing a host that was never logged in.
  it('exits 0 when there is no credential, noting it on stderr rather than stdout', () => {
    expect(runLogout(HOST, ctx)).toBe(0)
    expect(stderrOutput()).toContain(`no credential for ${HOST}`)
    expect(stdout()).toBe('')
  })

  it('reports a corrupt credentials file on stderr instead of throwing a stack trace', () => {
    saveToken(HOST, 'enc_a_valid_looking_token', ctx.env)
    writeFileSync(credentialsPath(ctx.env), '{ not json', { mode: 0o600 })

    expect(runLogout(HOST, ctx)).toBe(1)
    expect(stderrOutput()).toContain('remove it and log in again')
    expect(stdout()).toBe('')
  })
})
