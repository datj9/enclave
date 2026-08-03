import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { cliVersion, UNKNOWN_VERSION, USER_AGENT } from './src/version.ts'

const manifestVersion = (specifier: string): string =>
  (JSON.parse(readFileSync(new URL(specifier, import.meta.url), 'utf8')) as { version: string })
    .version

describe('cliVersion', () => {
  it('reads the version from packages/cli/package.json, not the workspace root', () => {
    // Compared against the manifest rather than a literal: the workspace root is versioned
    // independently of the published CLI package, and a literal here means every release bump
    // fails the release workflow's own test step before it can publish.
    expect(cliVersion()).toBe(manifestVersion('./package.json'))
  })

  it('names the published package in the User-Agent, not the binary', () => {
    // Server-side triage greps for what npm shows, which is `enclave-artifacts`.
    expect(USER_AGENT).toBe(`enclave-artifacts/${cliVersion()}`)
  })

  it('does not fall back to a version that could pass for a real release', () => {
    expect(UNKNOWN_VERSION).toBe('unknown')
  })
})
