import { describe, expect, it } from 'vitest'

import { cliVersion, UNKNOWN_VERSION, USER_AGENT } from './src/version.ts'

describe('cliVersion', () => {
  it('reads the version from packages/cli/package.json, not the workspace root', () => {
    // The workspace root package.json is versioned independently of the published CLI package.
    expect(cliVersion()).toBe('0.2.0')
  })

  it('names the published package in the User-Agent, not the binary', () => {
    // Server-side triage greps for what npm shows, which is `enclave-artifacts`.
    expect(USER_AGENT).toBe(`enclave-artifacts/${cliVersion()}`)
  })

  it('does not fall back to a version that could pass for a real release', () => {
    expect(UNKNOWN_VERSION).toBe('unknown')
  })
})
