import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PushCoreModule from '../push-core/src/index.ts'

import { push } from '../push-core/src/index.ts'
import type { PushResult } from '../push-core/src/index.ts'
import { runPush } from './src/commands/push.ts'
import type { ProjectState } from './src/state.ts'

vi.mock('../push-core/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PushCoreModule>()
  return { ...actual, push: vi.fn() }
})

const HOST = 'enclave.example.com'

const SUCCESS_RESULT: PushResult = {
  artifactId: '3f2a91c4-1111-4222-8333-444444444444',
  versionId: '9c8b7a65-5555-4666-8777-888888888888',
  versionNo: 1,
  viewUrl: 'https://3f2a91c4.artifacts.example.com',
  uploaded: ['index.html'],
  skipped: [{ path: 'app.js.map', reason: 'unsupported_extension' }],
}

describe('push command', () => {
  let workspace: string
  let projectDirectory: string
  let configHome: string
  let stdout: string
  let originalConfigHome: string | undefined
  let originalEnvironmentToken: string | undefined
  let originalHost: string | undefined

  function writeStateFile(state: ProjectState): void {
    writeFileSync(join(projectDirectory, '.enclave.json'), `${JSON.stringify(state, null, 2)}\n`)
  }

  /** The pre-fix location: beside the pushed directory, not inside it. */
  function writeLegacyStateFile(state: ProjectState): void {
    writeFileSync(join(workspace, '.enclave.json'), `${JSON.stringify(state, null, 2)}\n`)
  }

  beforeEach(() => {
    originalConfigHome = process.env['XDG_CONFIG_HOME']
    originalEnvironmentToken = process.env['ENCLAVE_TOKEN']
    originalHost = process.env['ENCLAVE_HOST']

    workspace = mkdtempSync(join(tmpdir(), 'enclave-push-'))
    configHome = mkdtempSync(join(tmpdir(), 'enclave-push-config-'))
    projectDirectory = join(workspace, 'dist')
    mkdirSync(projectDirectory)
    writeFileSync(join(projectDirectory, 'index.html'), '<!doctype html><title>hi</title>')
    writeFileSync(join(projectDirectory, 'app.js.map'), '{}')

    process.env['XDG_CONFIG_HOME'] = configHome
    process.env['ENCLAVE_TOKEN'] = 'a-test-token'
    delete process.env['ENCLAVE_HOST']

    stdout = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      stdout += String(chunk)
      return true
    })
    vi.mocked(push).mockResolvedValue(SUCCESS_RESULT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(push).mockReset()

    if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = originalConfigHome

    if (originalEnvironmentToken === undefined) delete process.env['ENCLAVE_TOKEN']
    else process.env['ENCLAVE_TOKEN'] = originalEnvironmentToken

    if (originalHost === undefined) delete process.env['ENCLAVE_HOST']
    else process.env['ENCLAVE_HOST'] = originalHost

    rmSync(workspace, { recursive: true, force: true })
    rmSync(configHome, { recursive: true, force: true })
  })

  it('refuses a second push when state exists', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 1 })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('S15')
    expect(stdout).toContain('.enclave.json exists (artifact 3f2a91c4)')
    expect(push).not.toHaveBeenCalled()
  })

  it('--new ignores an existing state file', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 1 })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: true,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('exits 1 when no token is available', async () => {
    delete process.env['ENCLAVE_TOKEN']

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('enclave login')
    expect(push).not.toHaveBeenCalled()
  })

  it('exits 2 when no host can be resolved', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(2)
    expect(push).not.toHaveBeenCalled()
  })

  it('--dry-run makes no network call', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).not.toHaveBeenCalled()
    expect(stdout).toContain('skipped 1 files:')
    expect(stdout).toContain('app.js.map        unsupported (.map)')
  })

  it('--dry-run fails a bundle with no index.html rather than reporting success', async () => {
    const emptyDirectory = join(workspace, 'empty')
    mkdirSync(emptyDirectory)
    writeFileSync(join(emptyDirectory, 'app.js'), 'console.log(1)')

    const exitCode = await runPush({
      directory: emptyDirectory,
      host: HOST,
      isNew: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('index.html')
    expect(push).not.toHaveBeenCalled()
  })

  it('--dry-run fails an empty directory rather than reporting success', async () => {
    const emptyDirectory = join(workspace, 'empty')
    mkdirSync(emptyDirectory)

    const exitCode = await runPush({
      directory: emptyDirectory,
      host: HOST,
      isNew: false,
      isDryRun: true,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout) as { error: { code: string } }).toMatchObject({
      error: { code: 'NOTHING_TO_UPLOAD' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('--dry-run fails a bundle over the default file count the same way a real push would', async () => {
    for (let index = 0; index < 51; index += 1) {
      writeFileSync(join(projectDirectory, `page-${String(index)}.html`), '<!doctype html>')
    }

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: true,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout) as { error: { code: string } }).toMatchObject({
      error: { code: 'BUNDLE_TOO_LARGE' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('writes the state file inside the pushed directory after a successful push', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    const written = JSON.parse(
      readFileSync(join(projectDirectory, '.enclave.json'), 'utf8'),
    ) as ProjectState
    // Persists the canonical form (scheme included), not the raw --host value — otherwise a
    // later mismatch check compares two spellings of the same host and misreports.
    expect(written).toEqual({
      host: `https://${HOST}`,
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })
  })

  it('--json prints only the result object', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('✓')
    expect(JSON.parse(stdout) as PushResult).toEqual(SUCCESS_RESULT)
  })

  it('refuses when the state host differs', async () => {
    writeStateFile({
      host: 'other.example.com',
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('other.example.com')
    expect(stdout).toContain(HOST)
    expect(push).not.toHaveBeenCalled()
  })

  it('reports INVALID_STATE with exit 1 for a corrupt state host, not a stack trace', async () => {
    writeStateFile({
      host: 'not a host',
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_STATE' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('treats a scheme change against a bare legacy state host as a mismatch, not a match', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 1 })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: 'http://enclave.example.com',
      isNew: false,
      isDryRun: false,
      isJson: false,
      isInsecureAllowed: true,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('http://enclave.example.com')
    expect(stdout).toContain('https://enclave.example.com')
    expect(push).not.toHaveBeenCalled()
  })

  it('sibling directories each keep their own state without colliding', async () => {
    const siblingDirectory = join(workspace, 'dist-b')
    mkdirSync(siblingDirectory)
    writeFileSync(join(siblingDirectory, 'index.html'), '<!doctype html>')
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 1 })

    const exitCode = await runPush({
      directory: siblingDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).toHaveBeenCalledTimes(1)
    const written = JSON.parse(
      readFileSync(join(siblingDirectory, '.enclave.json'), 'utf8'),
    ) as ProjectState
    expect(written.artifactId).toBe(SUCCESS_RESULT.artifactId)
  })

  it('reports INVALID_STATE for malformed JSON instead of throwing a stack trace', async () => {
    writeFileSync(join(projectDirectory, '.enclave.json'), '{ not json')

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_STATE' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('reports INVALID_STATE when artifactId is missing rather than treating it as no state', async () => {
    writeFileSync(
      join(projectDirectory, '.enclave.json'),
      `${JSON.stringify({ host: HOST, lastPushedVersionNo: 1 })}\n`,
    )

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_STATE' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('stops with move/delete instructions when a legacy parent state file exists', async () => {
    writeLegacyStateFile({
      host: HOST,
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stdout).toContain('legacy')
    expect(stdout).toContain('mv ')
    expect(stdout).toContain('rm ')
    expect(push).not.toHaveBeenCalled()
  })
})
