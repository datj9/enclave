import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvValidationError, parseEnv } from '@/env'

const REQUIRED_ENV: Readonly<Record<string, string>> = {
  APP_URL: 'https://app.example.com',
  ARTIFACT_ORIGIN_TEMPLATE: 'https://{id}.artifacts.example.com',
  DATABASE_URL: 'postgresql://enclave:enclave@localhost:5434/enclave',
  S3_ENDPOINT: 'https://s3.example.com',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'enclave-artifacts',
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
  SESSION_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: 'b'.repeat(32),
  DEFAULT_MODEL: 'claude-sonnet-4-6',
}

function envWithout(variableName: string): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(REQUIRED_ENV).filter(([name]) => name !== variableName))
}

function envWith(overrides: Record<string, string>): Record<string, string> {
  return { ...REQUIRED_ENV, ...overrides }
}

describe('parseEnv', () => {
  it('accepts a complete environment', () => {
    expect(() => parseEnv(REQUIRED_ENV)).not.toThrow()
  })

  it('applies the documented defaults when optional variables are absent', () => {
    const parsed = parseEnv(REQUIRED_ENV)

    expect(parsed.RATE_LIMIT_GENERATIONS_PER_HOUR).toBe(10)
    expect(parsed.RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY).toBe(100)
    expect(parsed.QUOTA_GENERATIONS_PER_DAY).toBe(100)
    expect(parsed.QUOTA_GENERATIONS_PER_DAY_OWN_KEY).toBe(1000)
    expect(parsed.BUNDLE_MAX_FILES).toBe(50)
    expect(parsed.BUNDLE_MAX_TOTAL_BYTES).toBe(10_485_760)
    expect(parsed.BUNDLE_MAX_FILE_BYTES).toBe(2_097_152)
    expect(parsed.PRESIGN_TTL_SECONDS).toBe(60)
    expect(parsed.HANDOFF_TTL_SECONDS).toBe(30)
    expect(parsed.ARTIFACT_GRANT_TTL_SECONDS).toBe(1800)
    expect(parsed.TRASH_RETENTION_DAYS).toBe(30)
    expect(parsed.AUDIT_RETENTION_DAYS).toBe(365)
  })

  it('defaults registration to invite-only', () => {
    expect(parseEnv(REQUIRED_ENV).ALLOW_OPEN_REGISTRATION).toBe(false)
  })

  it('coerces ALLOW_OPEN_REGISTRATION=true to a boolean', () => {
    expect(parseEnv(envWith({ ALLOW_OPEN_REGISTRATION: 'true' })).ALLOW_OPEN_REGISTRATION).toBe(
      true,
    )
  })

  it('rejects a non-boolean ALLOW_OPEN_REGISTRATION naming the variable', () => {
    expect(() => parseEnv(envWith({ ALLOW_OPEN_REGISTRATION: 'yes' }))).toThrow(
      /ALLOW_OPEN_REGISTRATION/,
    )
  })

  it.each(Object.keys(REQUIRED_ENV))('names %s when it is missing', (variableName) => {
    expect(() => parseEnv(envWithout(variableName))).toThrow(new RegExp(`\\b${variableName}\\b`))
  })

  it('rejects a SESSION_SECRET shorter than 32 bytes', () => {
    expect(() => parseEnv(envWith({ SESSION_SECRET: 'a'.repeat(31) }))).toThrow(/SESSION_SECRET/)
  })

  it('accepts a SESSION_SECRET of exactly 32 bytes', () => {
    expect(() => parseEnv(envWith({ SESSION_SECRET: 'a'.repeat(32) }))).not.toThrow()
  })

  it('rejects an ENCRYPTION_KEY shorter than 32 bytes', () => {
    expect(() => parseEnv(envWith({ ENCRYPTION_KEY: 'short' }))).toThrow(/ENCRYPTION_KEY/)
  })

  it('measures secret length in bytes, not characters', () => {
    // 16 multi-byte characters: 16 characters, 48 bytes.
    expect(() => parseEnv(envWith({ SESSION_SECRET: '☂'.repeat(16) }))).not.toThrow()
    expect(() => parseEnv(envWith({ SESSION_SECRET: '☂'.repeat(10) }))).toThrow(/SESSION_SECRET/)
  })

  it('rejects an ARTIFACT_ORIGIN_TEMPLATE without the {id} placeholder', () => {
    expect(() =>
      parseEnv(envWith({ ARTIFACT_ORIGIN_TEMPLATE: 'https://artifacts.example.com' })),
    ).toThrow(/ARTIFACT_ORIGIN_TEMPLATE/)
  })

  it('rejects a non-URL APP_URL', () => {
    expect(() => parseEnv(envWith({ APP_URL: 'app.example.com' }))).toThrow(/APP_URL/)
  })

  it('rejects a zero or negative numeric limit', () => {
    expect(() => parseEnv(envWith({ RATE_LIMIT_GENERATIONS_PER_HOUR: '0' }))).toThrow(
      /RATE_LIMIT_GENERATIONS_PER_HOUR/,
    )
    expect(() => parseEnv(envWith({ BUNDLE_MAX_FILES: '-1' }))).toThrow(/BUNDLE_MAX_FILES/)
  })

  it('rejects a non-numeric RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY', () => {
    expect(() =>
      parseEnv(envWith({ RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY: 'not-a-number' })),
    ).toThrow(/RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY/)
  })

  it('reports every offending variable at once, not just the first', () => {
    let caught: unknown
    try {
      parseEnv({ ...REQUIRED_ENV, SESSION_SECRET: 'short', ENCRYPTION_KEY: 'short' })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(EnvValidationError)
    expect((caught as EnvValidationError).problems).toHaveLength(2)
    expect((caught as EnvValidationError).message).toContain('SESSION_SECRET')
    expect((caught as EnvValidationError).message).toContain('ENCRYPTION_KEY')
  })
})

describe('env accessor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('reads a validated value lazily from process.env', async () => {
    vi.resetModules()
    vi.stubEnv('DEFAULT_MODEL', 'claude-opus-5')

    const { env } = await import('@/env')

    expect(env.DEFAULT_MODEL).toBe('claude-opus-5')
    expect(Object.keys(env)).toContain('SESSION_SECRET')
    expect('APP_URL' in env).toBe(true)
  })
})

describe('assertEnvOrExit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('exits non-zero and names the offending variable', async () => {
    vi.resetModules()
    vi.stubEnv('SESSION_SECRET', 'too-short')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit)

    const { assertEnvOrExit } = await import('@/env')
    assertEnvOrExit()

    expect(exit).toHaveBeenCalledWith(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('SESSION_SECRET')
  })

  it('stays silent on a valid environment', async () => {
    vi.resetModules()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as unknown as typeof process.exit)

    const { assertEnvOrExit } = await import('@/env')
    assertEnvOrExit()

    expect(exit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
