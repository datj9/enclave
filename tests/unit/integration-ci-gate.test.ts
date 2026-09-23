import { describe, expect, it, vi } from 'vitest'
import { isCi, missingServicesMessage, probeUntilReady } from '../integration/ci'

describe('isCi', () => {
  it.each([
    [{ CI: 'true' }, true],
    [{ CI: '1' }, true],
    [{ CI: 'TRUE' }, true],
    [{ CI: 'woodpecker' }, true],
    [{ CI: 'false' }, false],
    [{ CI: 'False' }, false],
    [{ CI: '0' }, false],
    [{ CI: '' }, false],
    [{ CI: '  ' }, false],
    [{}, false],
  ])('%o → %s', (env, expected) => {
    expect(isCi(env)).toBe(expected)
  })
})

describe('missingServicesMessage', () => {
  it('is null when both services answered', () => {
    expect(missingServicesMessage({ database: true, storage: true })).toBeNull()
  })

  it('names only the database when storage is up', () => {
    const message = missingServicesMessage({ database: false, storage: true })
    expect(message).toContain('Postgres on DATABASE_URL is unreachable')
    expect(message).not.toContain('S3_ENDPOINT')
  })

  it('names only storage when the database is up', () => {
    const message = missingServicesMessage({ database: true, storage: false })
    expect(message).toContain('S3-compatible storage on S3_ENDPOINT is unreachable')
    expect(message).not.toContain('DATABASE_URL')
  })

  it('names both, with plural agreement, when neither answered', () => {
    expect(missingServicesMessage({ database: false, storage: false })).toContain(
      'Postgres on DATABASE_URL and S3-compatible storage on S3_ENDPOINT are unreachable',
    )
  })
})

describe('probeUntilReady', () => {
  const up = { database: true, storage: true }
  const dbDown = { database: false, storage: true }

  it('outside CI, probes once and returns a failure for the caller to skip on', async () => {
    const probe = vi.fn().mockResolvedValue(dbDown)
    await expect(probeUntilReady(probe, { ci: false, delayMs: 0 })).resolves.toEqual(dbDown)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('under CI, retries a failed probe and returns once it recovers', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(dbDown)
      .mockResolvedValueOnce(dbDown)
      .mockResolvedValue(up)
    await expect(probeUntilReady(probe, { ci: true, delayMs: 0 })).resolves.toEqual(up)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('under CI, throws instead of returning a failure once the attempts run out', async () => {
    const probe = vi.fn().mockResolvedValue(dbDown)
    await expect(probeUntilReady(probe, { ci: true, attempts: 3, delayMs: 0 })).rejects.toThrow(
      'Postgres on DATABASE_URL is unreachable',
    )
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('under CI, a first-try success probes once', async () => {
    const probe = vi.fn().mockResolvedValue(up)
    await expect(probeUntilReady(probe, { ci: true, delayMs: 0 })).resolves.toEqual(up)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
