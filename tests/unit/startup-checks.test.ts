import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('warnIfArtifactOriginLooksUnconfigured', () => {
  async function runWithTemplate(template: string): Promise<string[]> {
    vi.resetModules()
    vi.stubEnv('ARTIFACT_ORIGIN_TEMPLATE', template)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { warnIfArtifactOriginLooksUnconfigured } = await import('@/lib/startup-checks')
    warnIfArtifactOriginLooksUnconfigured()

    return warn.mock.calls.map((call) => String(call[0]))
  }

  it('warns and names the variable when the artifact origin is not https', async () => {
    const warnings = await runWithTemplate('http://{id}.artifacts.localhost:3000')

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('ARTIFACT_ORIGIN_TEMPLATE')
  })

  it('stays quiet when the artifact origin is https', async () => {
    await expect(runWithTemplate('https://{id}.artifacts.example.com')).resolves.toEqual([])
  })
})

// `recordAuditEvent` moved to tests/unit/audit.test.ts when S4 gave it the `audit_log` table.
