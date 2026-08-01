import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordAuditEvent } from '@/lib/audit'

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

describe('recordAuditEvent', () => {
  it('emits one JSON line carrying the action and actor', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    recordAuditEvent({
      action: 'auth.login_failed',
      actorIp: '203.0.113.7',
      metadata: { reason: 'invalid_credentials' },
    })

    expect(info).toHaveBeenCalledOnce()
    const logged: unknown = JSON.parse(String(info.mock.calls[0]?.[0]))
    expect(logged).toMatchObject({
      kind: 'audit',
      action: 'auth.login_failed',
      actorIp: '203.0.113.7',
      metadata: { reason: 'invalid_credentials' },
    })
  })
})
