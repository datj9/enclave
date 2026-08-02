import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CredentialError,
  credentialsPath,
  forgetToken,
  readCredentials,
  saveToken,
  tokenFor,
} from './src/credentials.ts'

describe('credentials', () => {
  let configHome: string
  let originalConfigHome: string | undefined
  let originalEnvironmentToken: string | undefined

  beforeEach(() => {
    originalConfigHome = process.env['XDG_CONFIG_HOME']
    originalEnvironmentToken = process.env['ENCLAVE_TOKEN']
    configHome = mkdtempSync(join(tmpdir(), 'enclave-credentials-'))
    process.env['XDG_CONFIG_HOME'] = configHome
    delete process.env['ENCLAVE_TOKEN']
  })

  afterEach(() => {
    if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = originalConfigHome

    if (originalEnvironmentToken === undefined) delete process.env['ENCLAVE_TOKEN']
    else process.env['ENCLAVE_TOKEN'] = originalEnvironmentToken

    rmSync(configHome, { recursive: true, force: true })
  })

  it('returns an empty map when the file is absent', () => {
    expect(readCredentials()).toEqual({})
  })

  it('saveToken writes mode 0600', () => {
    saveToken('enclave.example.com', 'first-secret')

    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600)
  })

  it('saveToken keeps other hosts', () => {
    saveToken('enclave.example.com', 'first-secret')
    saveToken('localhost:3000', 'second-secret')

    expect(Object.keys(readCredentials()).sort()).toEqual(['enclave.example.com', 'localhost:3000'])
  })

  it('tokenFor prefers ENCLAVE_TOKEN', () => {
    saveToken('enclave.example.com', 'from-the-file')
    process.env['ENCLAVE_TOKEN'] = 'from-the-environment'

    expect(tokenFor('enclave.example.com')).toBe('from-the-environment')
  })

  it('tokenFor returns null for an unknown host', () => {
    saveToken('enclave.example.com', 'first-secret')

    expect(tokenFor('other.example.com')).toBeNull()
  })

  it('readCredentials throws when group readable', () => {
    saveToken('enclave.example.com', 'first-secret')
    chmodSync(credentialsPath(), 0o640)

    expect(() => readCredentials()).toThrow(CredentialError)
  })

  it('forgetToken removes one host and reports true', () => {
    saveToken('enclave.example.com', 'first-secret')
    saveToken('localhost:3000', 'second-secret')

    expect(forgetToken('enclave.example.com')).toBe(true)
    expect(Object.keys(readCredentials())).toEqual(['localhost:3000'])
  })

  it('forgetToken returns false for an unknown host', () => {
    saveToken('enclave.example.com', 'first-secret')

    expect(forgetToken('other.example.com')).toBe(false)
  })
})
