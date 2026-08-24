import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CredentialError,
  credentialsPath,
  forgetToken,
  readCredentials,
  saveToken,
  tokenFor,
} from './src/credentials.ts'

function thrownError(fn: () => unknown): Error {
  try {
    fn()
  } catch (caught) {
    return caught as Error
  }
  throw new Error('expected the call to throw')
}

/** Captures everything written to stderr while a call runs, then restores the real writer. */
function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = []
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return {
    text: () => chunks.join(''),
    restore: () => write.mockRestore(),
  }
}

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
    const captured = captureStderr()

    try {
      expect(tokenFor('enclave.example.com')).toBe('from-the-environment')
      expect(captured.text()).toMatch(/ENCLAVE_TOKEN is overriding/)
    } finally {
      captured.restore()
    }
  })

  /** `login` already trims before deciding a token was entered; `tokenFor` has to agree, or a
   *  trailing space in a .env file sends `Bearer    ` and hides a perfectly good stored token. */
  it('tokenFor treats a whitespace-only ENCLAVE_TOKEN as absent', () => {
    saveToken('enclave.example.com', 'from-the-file')
    process.env['ENCLAVE_TOKEN'] = '   '

    expect(tokenFor('enclave.example.com')).toBe('from-the-file')
  })

  it('tokenFor trims a padded ENCLAVE_TOKEN rather than sending the padding', () => {
    process.env['ENCLAVE_TOKEN'] = '  from-the-environment  '

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

  it('readCredentials throws a named error, not a JSON.parse stack trace, on malformed JSON', () => {
    saveToken('enclave.example.com', 'first-secret')
    writeFileSync(credentialsPath(), '{ not json', { mode: 0o600 })

    expect(() => readCredentials()).toThrow(CredentialError)
  })

  it('readCredentials throws on a valid JSON document with the wrong shape', () => {
    saveToken('enclave.example.com', 'first-secret')
    writeFileSync(credentialsPath(), JSON.stringify(['not', 'a', 'map']), { mode: 0o600 })

    expect(() => readCredentials()).toThrow(CredentialError)
  })

  it('readCredentials throws on an entry missing its token', () => {
    saveToken('enclave.example.com', 'first-secret')
    writeFileSync(
      credentialsPath(),
      JSON.stringify({ 'enclave.example.com': { nope: true } }),
      { mode: 0o600 },
    )

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

  it('tokenFor finds a legacy entry keyed on the bare host', () => {
    saveToken('enclave.example.com', 'legacy-secret')

    expect(tokenFor('https://enclave.example.com')).toBe('legacy-secret')
  })

  it('tokenFor prefers the canonical key over a legacy one', () => {
    saveToken('enclave.example.com', 'legacy-secret')
    saveToken('https://enclave.example.com', 'canonical-secret')

    expect(tokenFor('https://enclave.example.com')).toBe('canonical-secret')
  })

  it('forgetToken clears a legacy entry keyed on the bare host', () => {
    saveToken('enclave.example.com', 'legacy-secret')

    expect(forgetToken('https://enclave.example.com')).toBe(true)
    expect(readCredentials()).toEqual({})
  })

  it('tokenFor never returns a legacy https-minted token for an http lookup', () => {
    saveToken('enclave.example.com', 'legacy-secret')

    expect(tokenFor('http://enclave.example.com')).toBeNull()
    expect(tokenFor('https://enclave.example.com')).toBe('legacy-secret')
  })

  it('forgetToken clears both the canonical and a coexisting legacy entry', () => {
    saveToken('enclave.example.com', 'legacy-secret')
    saveToken('https://enclave.example.com', 'canonical-secret')

    expect(forgetToken('https://enclave.example.com')).toBe(true)
    expect(readCredentials()).toEqual({})
  })

  it('tokenFor resolves every legacy key spelling to the same canonical host', () => {
    for (const legacyKey of [
      'enclave.example.com/',
      'Enclave.Example.COM',
      'enclave.example.com:443',
    ]) {
      saveToken(legacyKey, 'legacy-secret')
      expect(tokenFor('https://enclave.example.com')).toBe('legacy-secret')
      forgetToken('https://enclave.example.com')
    }
  })

  // --- R1: a filesystem failure must not be reported as corrupt JSON ---

  it.skipIf(process.getuid?.() === 0)(
    'readCredentials reports a read failure as a permission problem, not as malformed JSON',
    () => {
      saveToken('enclave.example.com', 'first-secret')
      chmodSync(credentialsPath(), 0o000)

      const error = thrownError(() => readCredentials())

      expect(error).toBeInstanceOf(CredentialError)
      expect(error.message).toMatch(/could not be read/)
      expect(error.message).not.toMatch(/not valid JSON/)
      expect(error.message).not.toMatch(/remove it/)
    },
  )

  it('readCredentials names a directory at the credentials path as such', () => {
    mkdirSync(credentialsPath(), { recursive: true })

    const error = thrownError(() => readCredentials())

    expect(error).toBeInstanceOf(CredentialError)
    expect(error.message).toMatch(/is not a regular file/)
  })

  it('readCredentials still reports genuinely malformed JSON as malformed JSON', () => {
    saveToken('enclave.example.com', 'first-secret')
    writeFileSync(credentialsPath(), '{ not json', { mode: 0o600 })

    const error = thrownError(() => readCredentials())

    expect(error).toBeInstanceOf(CredentialError)
    expect(error.message).toMatch(/is not valid JSON/)
  })

  // --- R3: ENCLAVE_TOKEN must not silently shadow a different stored credential ---

  it('tokenFor warns when ENCLAVE_TOKEN differs from the stored credential', () => {
    saveToken('enclave.example.com', 'stored')
    process.env['ENCLAVE_TOKEN'] = 'different'
    const captured = captureStderr()

    try {
      expect(tokenFor('enclave.example.com')).toBe('different')
      expect(captured.text()).toMatch(/ENCLAVE_TOKEN is overriding/)
      expect(captured.text()).toContain('enclave.example.com')
    } finally {
      captured.restore()
    }
  })

  it('tokenFor is silent when ENCLAVE_TOKEN equals the stored credential', () => {
    saveToken('enclave.example.com', 'same-secret')
    process.env['ENCLAVE_TOKEN'] = 'same-secret'
    const captured = captureStderr()

    try {
      expect(tokenFor('enclave.example.com')).toBe('same-secret')
      expect(captured.text()).not.toMatch(/ENCLAVE_TOKEN is overriding/)
    } finally {
      captured.restore()
    }
  })

  it('tokenFor is silent when nothing is stored for the host', () => {
    process.env['ENCLAVE_TOKEN'] = 'env-only'
    const captured = captureStderr()

    try {
      expect(tokenFor('enclave.example.com')).toBe('env-only')
      expect(captured.text()).not.toMatch(/ENCLAVE_TOKEN is overriding/)
    } finally {
      captured.restore()
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'tokenFor still returns the environment token when the credentials file is unreadable',
    () => {
      saveToken('enclave.example.com', 'stored')
      chmodSync(credentialsPath(), 0o000)
      process.env['ENCLAVE_TOKEN'] = 'env-token'
      const captured = captureStderr()

      try {
        expect(tokenFor('enclave.example.com')).toBe('env-token')
        expect(captured.text()).not.toMatch(/ENCLAVE_TOKEN is overriding/)
      } finally {
        captured.restore()
      }
    },
  )

  it('tokenFor still returns the environment token when the credentials file is malformed', () => {
    saveToken('enclave.example.com', 'first-secret')
    writeFileSync(credentialsPath(), '{ not json', { mode: 0o600 })
    process.env['ENCLAVE_TOKEN'] = 'env-token'
    const captured = captureStderr()

    try {
      expect(tokenFor('enclave.example.com')).toBe('env-token')
      expect(captured.text()).not.toMatch(/ENCLAVE_TOKEN is overriding/)
    } finally {
      captured.restore()
    }
  })

  it('the warning never contains the token value', () => {
    saveToken('enclave.example.com', 'tok-9d5f')
    process.env['ENCLAVE_TOKEN'] = 'tok-2b71'
    const captured = captureStderr()

    try {
      tokenFor('enclave.example.com')
      expect(captured.text()).not.toContain('tok-9d5f')
      expect(captured.text()).not.toContain('tok-2b71')
    } finally {
      captured.restore()
    }
  })
})
