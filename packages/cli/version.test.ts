import { describe, expect, it } from 'vitest'

import { cliVersion, USER_AGENT } from './src/version.ts'

describe('cliVersion', () => {
  it('reads the version from packages/cli/package.json, not the workspace root', () => {
    // The workspace root package.json is versioned independently of the published CLI package.
    expect(cliVersion()).toBe('0.2.0')
  })

  it('builds a User-Agent that names the CLI and carries its version', () => {
    expect(USER_AGENT).toBe(`enclave-cli/${cliVersion()}`)
  })
})
