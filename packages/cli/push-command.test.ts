import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PushCoreModule from '../push-core/src/index.ts'

import { collectBundle, push, PushError } from '../push-core/src/index.ts'
import type { DeadLink, PushResult, UploadPlan } from '../push-core/src/index.ts'
import { apiClient } from './src/api-client.ts'
import { runPush } from './src/commands/push.ts'
import type { ProjectState } from './src/state.ts'
import { USER_AGENT } from './src/version.ts'

vi.mock('./src/api-client.ts', () => ({ apiClient: vi.fn() }))

const { collectBundle: realCollectBundle } =
  await vi.importActual<typeof PushCoreModule>('../push-core/src/index.ts')

vi.mock('../push-core/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PushCoreModule>()
  return { ...actual, push: vi.fn(), collectBundle: vi.fn() }
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
  let stderr: string
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
    stderr = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown): boolean => {
      stderr += String(chunk)
      return true
    })
    vi.mocked(push).mockResolvedValue(SUCCESS_RESULT)
    vi.mocked(collectBundle).mockImplementation(realCollectBundle)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(push).mockReset()
    vi.mocked(collectBundle).mockReset()

    if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = originalConfigHome

    if (originalEnvironmentToken === undefined) delete process.env['ENCLAVE_TOKEN']
    else process.env['ENCLAVE_TOKEN'] = originalEnvironmentToken

    if (originalHost === undefined) delete process.env['ENCLAVE_HOST']
    else process.env['ENCLAVE_HOST'] = originalHost

    rmSync(workspace, { recursive: true, force: true })
    rmSync(configHome, { recursive: true, force: true })
  })

  it('a second push appends a version to the artifact the state file names', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })
    vi.mocked(push).mockResolvedValue({ ...SUCCESS_RESULT, versionNo: 3 })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: SUCCESS_RESULT.artifactId,
        expectedVersionNo: 2,
      }),
    )
    expect(stdout).toContain('✓ updated 3f2a91c4  v3')
  })

  it('records the version the server returned, not a hard-coded 1', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })
    vi.mocked(push).mockResolvedValue({ ...SUCCESS_RESULT, versionNo: 3 })

    await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    const written = JSON.parse(
      readFileSync(join(projectDirectory, '.enclave.json'), 'utf8'),
    ) as ProjectState
    expect(written.lastPushedVersionNo).toBe(3)
  })

  it('--force drops the expected-version guard', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })

    await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: true,
      isDryRun: false,
      isJson: false,
    })

    const [options] = vi.mocked(push).mock.calls[0] ?? []
    expect(options?.artifactId).toBe(SUCCESS_RESULT.artifactId)
    expect(options).not.toHaveProperty('expectedVersionNo')
  })

  it('names both versions and points at --force when the server is ahead', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })
    vi.mocked(push).mockRejectedValue(
      new PushError('VERSION_CONFLICT', 'The artifact has a newer version than expected', {
        expectedVersionNo: 2,
        currentVersionNo: 5,
      }),
    )

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('✗ server is at v5, you last pushed v2')
    expect(stderr).toContain('refusing to overwrite a newer version')
    expect(stderr).toContain('re-run with --force to publish anyway')
    expect(stdout).toBe('')
  })

  it('offers --new when the artifact the state file tracks is gone', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })
    vi.mocked(push).mockRejectedValue(new PushError('NOT_FOUND', 'Artifact not found', {}))

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('use --new to publish this directory as a new artifact')
  })

  describe('--artifact', () => {
    const OTHER_ID = '7d5e3b21-2222-4333-8444-555555555555'

    /** The listing `resolveArtifactId` walks to turn a prefix into a full id. */
    function stubListing(items: readonly { id: string; title: string }[]): void {
      vi.mocked(apiClient).mockReturnValue({
        get: vi.fn().mockResolvedValue({ items, nextCursor: null }),
        post: vi.fn(),
        patch: vi.fn(),
        remove: vi.fn(),
      })
    }

    it('appends to the named artifact when the directory has no state file', async () => {
      vi.mocked(push).mockResolvedValue({ ...SUCCESS_RESULT, versionNo: 4 })

      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: SUCCESS_RESULT.artifactId,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(exitCode).toBe(0)
      const [options] = vi.mocked(push).mock.calls[0] ?? []
      expect(options?.artifactId).toBe(SUCCESS_RESULT.artifactId)
      // Nothing local to compare against, so there is no version to guard.
      expect(options).not.toHaveProperty('expectedVersionNo')
      expect(stdout).toContain('✓ updated 3f2a91c4  v4')
    })

    it('keeps the version guard when it agrees with the state file', async () => {
      writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })

      await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: SUCCESS_RESULT.artifactId,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(push).toHaveBeenCalledWith(expect.objectContaining({ expectedVersionNo: 2 }))
    })

    it('refuses when it disagrees with the state file', async () => {
      writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 2 })

      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: OTHER_ID,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(exitCode).toBe(1)
      expect(stderr).toContain('7d5e3b21')
      expect(stderr).toContain('3f2a91c4')
      expect(push).not.toHaveBeenCalled()
    })

    it('rejects the pair --artifact --new as contradictory', async () => {
      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: SUCCESS_RESULT.artifactId,
        isNew: true,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(exitCode).toBe(2)
      expect(push).not.toHaveBeenCalled()
    })

    it('resolves a prefix against the caller\'s own artifacts', async () => {
      stubListing([{ id: SUCCESS_RESULT.artifactId, title: 'Kanban' }])

      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: '3f2a91c4',
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(exitCode).toBe(0)
      expect(push).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: SUCCESS_RESULT.artifactId }),
      )
    })

    it('exits 2 on a prefix too short to be unambiguous', async () => {
      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: '3f2a',
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(exitCode).toBe(2)
      expect(push).not.toHaveBeenCalled()
    })

    it('a full uuid costs no listing request, so artifacts:read is not needed', async () => {
      const get = vi.fn()
      vi.mocked(apiClient).mockReturnValue({ get, post: vi.fn(), patch: vi.fn(), remove: vi.fn() })

      await runPush({
        directory: projectDirectory,
        host: HOST,
        artifactRef: SUCCESS_RESULT.artifactId,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(get).not.toHaveBeenCalled()
    })
  })

  it('--new ignores an existing state file', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 1 })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: true,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('identifies itself with a User-Agent naming the CLI and its version', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(vi.mocked(push).mock.calls[0]?.[0]).toMatchObject({ userAgent: USER_AGENT })
  })

  it('exits 1 when no token is available', async () => {
    delete process.env['ENCLAVE_TOKEN']

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('enclave login')
    expect(push).not.toHaveBeenCalled()
  })

  it('exits 2 when no host can be resolved', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      isNew: false,
      isForced: false,
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
      isForced: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).not.toHaveBeenCalled()
    expect(stdout).toContain('skipped 1 files:')
    // The invariant, not a fixed column: what matters is that a gap separates path from reason.
    expect(stdout).toMatch(/^ {2}app\.js\.map {2,}unsupported \(\.map\)$/m)
  })

  it('keeps a path longer than the old fixed column off its own reason', async () => {
    writeFileSync(join(projectDirectory, 'application-bundle.js.map'), '{}')

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('.mapunsupported')
    expect(stdout).toMatch(/^ {2}application-bundle\.js\.map {2}unsupported \(\.map\)$/m)
    // The narrower path is padded out to the widest one, so the reasons still line up.
    expect(stdout).toMatch(/^ {2}app\.js\.map {17}unsupported \(\.map\)$/m)
  })

  it('warns about a link to a file the bundle does not contain, without failing the push', async () => {
    writeFileSync(join(projectDirectory, 'index.html'), '<a href="gone.html">gone</a>')

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toContain('warning: 1 link points at a file not in this bundle:')
    expect(stderr).toContain('index.html → gone.html')
  })

  it('--json dry run puts dead links in the result and keeps the warning off stderr', async () => {
    writeFileSync(join(projectDirectory, 'index.html'), '<a href="gone.html">gone</a>')

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: true,
    })

    expect(exitCode).toBe(0)
    const payload = JSON.parse(stdout) as {
      readonly deadLinks: readonly DeadLink[]
    } & { readonly uploaded: readonly string[] }
    expect(payload.deadLinks).toEqual([{ from: 'index.html', to: 'gone.html' }])
    expect(stderr).not.toContain('warning:')
  })

  it('reports an unreadable directory in the --json error envelope, not as a bare throw', async () => {
    vi.mocked(collectBundle).mockImplementationOnce(() => {
      throw new Error(`EACCES: permission denied, open '${join(projectDirectory, 'a.css')}'`)
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(push).not.toHaveBeenCalled()
    expect(stdout).toBe('')
    expect(JSON.parse(stderr) as { readonly error: { code: string; message: string } }).toEqual({
      error: { code: 'UNREADABLE_DIRECTORY', message: expect.stringContaining('EACCES') },
    })
  })

  it('reports an unreadable directory on the dry-run path too', async () => {
    vi.mocked(collectBundle).mockImplementationOnce(() => {
      throw new Error(`EACCES: permission denied, open '${join(projectDirectory, 'a.css')}'`)
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(push).not.toHaveBeenCalled()
    expect(stdout).toBe('')
    expect(JSON.parse(stderr) as { readonly error: { code: string; message: string } }).toEqual({
      error: { code: 'UNREADABLE_DIRECTORY', message: expect.stringContaining('EACCES') },
    })
  })

  it('hands push the bundle it already read rather than making it read the tree again', async () => {
    await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(vi.mocked(collectBundle)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(push).mock.calls[0]?.[0]?.bundle?.files.map((file) => file.path)).toEqual([
      'index.html',
    ])
  })

  it('warns about dead links before the upload, not after the version exists', async () => {
    writeFileSync(join(projectDirectory, 'index.html'), '<a href="gone.html">gone</a>')
    let stderrWhenPushCalled = ''
    vi.mocked(push).mockImplementation(async () => {
      stderrWhenPushCalled = stderr
      return SUCCESS_RESULT
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(stderrWhenPushCalled).toContain('warning: 1 link points at a file not in this bundle:')
    expect(stderrWhenPushCalled).toContain('index.html → gone.html')
  })

  it('warns about a root-absolute link the bundle cannot satisfy', async () => {
    writeFileSync(join(projectDirectory, 'index.html'), '<a href="/REPORT.html">report</a>')

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toContain('warning: 1 link points at a file not in this bundle:')
    expect(stderr).toContain('index.html → REPORT.html')
  })

  it('counts links in the plural only when there is more than one', async () => {
    writeFileSync(
      join(projectDirectory, 'index.html'),
      '<a href="gone.html">a</a><img src="missing.png">',
    )

    expect(
      await runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: true,
        isJson: false,
      }),
    ).toBe(0)
    expect(stderr).toContain('warning: 2 links point at files not in this bundle:')
  })

  it('--dry-run fails a bundle with no index.html rather than reporting success', async () => {
    const emptyDirectory = join(workspace, 'empty')
    mkdirSync(emptyDirectory)
    writeFileSync(join(emptyDirectory, 'app.js'), 'console.log(1)')

    const exitCode = await runPush({
      directory: emptyDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('index.html')
    expect(push).not.toHaveBeenCalled()
  })

  it('--dry-run fails an empty directory rather than reporting success', async () => {
    const emptyDirectory = join(workspace, 'empty')
    mkdirSync(emptyDirectory)

    const exitCode = await runPush({
      directory: emptyDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
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
      isForced: false,
      isDryRun: true,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
      error: { code: 'BUNDLE_TOO_LARGE' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('writes the state file inside the pushed directory after a successful push', async () => {
    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
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
      isForced: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('✓')
    // The dead-link check appends its findings to the result, even when it found none.
    expect(JSON.parse(stdout) as PushResult & { readonly deadLinks: readonly DeadLink[] }).toEqual({
      ...SUCCESS_RESULT,
      deadLinks: [],
    })
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
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('other.example.com')
    expect(stderr).toContain(HOST)
    expect(push).not.toHaveBeenCalled()
  })

  it('reports INVALID_STATE with exit 1 when a corrupt state host is the only host', async () => {
    writeStateFile({
      host: 'not a host',
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    const reported = JSON.parse(stderr) as { error: { code: string; message: string } }
    expect(reported).toMatchObject({ error: { code: 'INVALID_STATE' } })
    // The host appears nowhere on the command line, so the message has to say where it came from.
    expect(reported.error.message).toContain('.enclave.json')
    expect(push).not.toHaveBeenCalled()
  })

  it('reports a corrupt state host as a mismatch when --host supplied the target', async () => {
    // The state file describes a different instance; --host won, so which host is in play is the
    // useful thing to say — not that a file the push is no longer reading is malformed.
    writeStateFile({
      host: 'not a host',
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
      error: { code: 'HOST_MISMATCH' },
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('treats a scheme change against a bare legacy state host as a mismatch, not a match', async () => {
    writeStateFile({ host: HOST, artifactId: SUCCESS_RESULT.artifactId, lastPushedVersionNo: 1 })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: 'http://enclave.example.com',
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
      isInsecureAllowed: true,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('http://enclave.example.com')
    expect(stderr).toContain('https://enclave.example.com')
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
      isForced: false,
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
      isForced: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
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
      isForced: false,
      isDryRun: false,
      isJson: true,
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
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
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(1)
    expect(stderr).toContain('mv ')
    // Never `rm <parent>/.enclave.json`: the parent may be a live project whose state that is.
    expect(stderr).not.toContain('rm ')
    expect(stderr).toContain('--new')
    expect(push).not.toHaveBeenCalled()
  })

  it('lets --new past a parent state file instead of advising its deletion', async () => {
    writeLegacyStateFile({
      host: HOST,
      artifactId: SUCCESS_RESULT.artifactId,
      lastPushedVersionNo: 1,
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: true,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(push).toHaveBeenCalled()
  })

  describe('an unusable directory is refused before anything else happens', () => {
    it('names the missing directory rather than blaming the server', async () => {
      const exitCode = await runPush({
        directory: join(workspace, 'does-not-exist'),
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: true,
      })

      expect(exitCode).toBe(2)
      expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
        error: { code: 'DIRECTORY_NOT_FOUND' },
      })
      expect(push).not.toHaveBeenCalled()
    })

    it('keeps the JSON envelope on the dry-run path', async () => {
      const exitCode = await runPush({
        directory: join(workspace, 'does-not-exist'),
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: true,
        isJson: true,
      })

      expect(exitCode).toBe(2)
      expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
        error: { code: 'DIRECTORY_NOT_FOUND' },
      })
    })

    it('distinguishes a file from a missing path', async () => {
      const file = join(workspace, 'bundle.html')
      writeFileSync(file, '<!doctype html>')

      const exitCode = await runPush({
        directory: file,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: true,
        isJson: true,
      })

      expect(exitCode).toBe(2)
      expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
        error: { code: 'NOT_A_DIRECTORY' },
      })
    })
  })

  describe('the success block hands over an address that works', () => {
    async function pushSuccessfully(visibility?: 'private' | 'org' | 'public'): Promise<number> {
      return runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
        ...(visibility === undefined ? {} : { visibility }),
      })
    }

    it('prints the /a/<id> page, not the artifact origin that 404s without a grant', async () => {
      expect(await pushSuccessfully()).toBe(0)

      expect(stdout).toContain(`→ https://${HOST}/a/${SUCCESS_RESULT.artifactId}`)
      expect(stdout).not.toContain('.artifacts.')
    })

    it('names the next action instead of ending on a bare URL', async () => {
      expect(await pushSuccessfully()).toBe(0)

      expect(stdout).toContain('private — only you can open that link')
      expect(stdout).toContain('enclave share create 3f2a91c4 --expires 7d')
      expect(stdout).toContain('enclave privacy 3f2a91c4 org')
    })

    it('drops the privacy line when --visibility said what to do', async () => {
      expect(await pushSuccessfully('org')).toBe(0)

      expect(stdout).not.toContain('only you can open that link')
      expect(stdout).toContain('enclave share create 3f2a91c4 --expires 7d')
    })

    it('never proposes a downgrade to org after an already-open push', async () => {
      expect(await pushSuccessfully('public')).toBe(0)

      expect(stdout).not.toContain('enclave privacy 3f2a91c4 org')
      expect(stdout).toContain('enclave share create 3f2a91c4 --expires 7d')
    })

    it('leaves viewUrl in the --json result, which is a pinned contract', async () => {
      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: true,
      })

      expect(exitCode).toBe(0)
      expect((JSON.parse(stdout) as PushResult).viewUrl).toBe(SUCCESS_RESULT.viewUrl)
    })
  })

  describe('the upload says it is happening', () => {
    function announcementOf(plan: UploadPlan): string {
      const onUploadStart = vi.mocked(push).mock.calls[0]?.[0]?.onUploadStart
      if (onUploadStart === undefined) throw new Error('no onUploadStart was passed')
      onUploadStart(plan)
      return stderr
    }

    async function pushOnce(isJson: boolean): Promise<number> {
      return runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson,
      })
    }

    it('writes the file count, size and host to stderr, never to stdout', async () => {
      expect(await pushOnce(false)).toBe(0)

      const announcement = announcementOf({ fileCount: 12, totalBytes: 348_160 })
      expect(announcement).toContain(`uploading 12 files (340 KB) to https://${HOST}`)
      expect(stdout).not.toContain('uploading')
    })

    it('stays quiet under --json, which promises stdout is the result and nothing else', async () => {
      expect(await pushOnce(true)).toBe(0)

      expect(vi.mocked(push).mock.calls[0]?.[0]?.onUploadStart).toBeUndefined()
      expect(JSON.parse(stdout) as PushResult & { readonly deadLinks: readonly DeadLink[] }).toEqual({
        ...SUCCESS_RESULT,
        deadLinks: [],
      })
    })
  })

  describe('a token the server rejects mid-push', () => {
    beforeEach(() => {
      vi.mocked(push).mockRejectedValue(new PushError('UNAUTHORIZED', 'The API token is not valid'))
    })

    it('names the command that fixes it, as the no-token path already does', async () => {
      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: false,
      })

      expect(exitCode).toBe(1)
      expect(stderr).toContain(`enclave login --host https://${HOST}`)
    })

    it('adds nothing to the --json envelope, which still has to parse', async () => {
      const exitCode = await runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: false,
        isJson: true,
      })

      expect(exitCode).toBe(1)
      expect(JSON.parse(stderr) as { error: { code: string } }).toMatchObject({
        error: { code: 'UNAUTHORIZED' },
      })
    })
  })

  describe('refusal details stay readable in human mode', () => {
    it('names the skipped file and why, instead of [object Object]', async () => {
      const oversized = join(workspace, 'oversized')
      mkdirSync(oversized)
      writeFileSync(join(oversized, 'index.html'), 'x'.repeat(3 * 1024 * 1024))

      const exitCode = await runPush({
        directory: oversized,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: true,
        isJson: false,
      })

      expect(exitCode).toBe(1)
      expect(stderr).not.toContain('[object Object]')
      expect(stderr).toContain('index.html')
      expect(stderr).toContain('too large')
    })

    it('omits the detail line when there is no detail to render', async () => {
      const noIndex = join(workspace, 'no-index')
      mkdirSync(noIndex)
      writeFileSync(join(noIndex, 'about.html'), '<!doctype html>')

      const exitCode = await runPush({
        directory: noIndex,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: true,
        isJson: false,
      })

      expect(exitCode).toBe(1)
      expect(stderr).not.toMatch(/skipped=\s*$/m)
    })
  })
})
