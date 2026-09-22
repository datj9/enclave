import { describe, expect, it } from 'vitest'
import { isCi, missingServicesMessage } from '../integration/ci'

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
