import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { main } from './src/main.ts'
import { cliVersion } from './src/version.ts'

/**
 * `parseArgs` applies every declared flag to every command unless something narrows it. These
 * cases exist because `rm <id> --dry-run` used to exit 0 having deleted the artifact — the flag
 * users learn from `push` was silently discarded, and nothing failed.
 */

const runList = vi.fn(async () => Promise.resolve(0))
const runRemove = vi.fn(async () => Promise.resolve(0))
const runShareCreate = vi.fn(async () => Promise.resolve(0))

vi.mock('./src/commands/artifacts.ts', () => ({
  runList: (...args: unknown[]) => runList(...(args as [])),
  runRemove: (...args: unknown[]) => runRemove(...(args as [])),
  runPrivacy: vi.fn(),
  runRename: vi.fn(),
  runRestore: vi.fn(),
  runShow: vi.fn(),
}))
vi.mock('./src/commands/login.ts', () => ({ runLogin: vi.fn() }))
vi.mock('./src/commands/logout.ts', () => ({ runLogout: vi.fn() }))
vi.mock('./src/commands/push.ts', () => ({ runPush: vi.fn() }))
vi.mock('./src/commands/shares.ts', () => ({
  runShareCreate: (...args: unknown[]) => runShareCreate(...(args as [])),
  runShareList: vi.fn(),
  runShareRevoke: vi.fn(),
}))

const HOST = 'https://enclave.example.com'
const ARTIFACT_ID = '0a550eb2-1111-4222-8333-444444444444'

let written: string[]
let writtenToStderr: string[]

function stdout(): string {
  return written.join('')
}

function stderr(): string {
  return writtenToStderr.join('')
}

beforeEach(() => {
  written = []
  writtenToStderr = []
  runList.mockClear()
  runRemove.mockClear()
  runShareCreate.mockClear()
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    writtenToStderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('per-command option allowlist', () => {
  it('refuses --dry-run on rm instead of deleting while reading as a rehearsal', async () => {
    const exitCode = await main(['rm', ARTIFACT_ID, '--host', HOST, '--dry-run'])

    expect(exitCode).toBe(2)
    expect(runRemove).not.toHaveBeenCalled()
    expect(stderr()).toContain("--dry-run is not an option for 'rm'")
  })

  it('refuses --version on rm, which would otherwise be silently discarded', async () => {
    const exitCode = await main(['rm', ARTIFACT_ID, '--host', HOST, '--version', 'bogus'])

    expect(exitCode).toBe(2)
    expect(runRemove).not.toHaveBeenCalled()
  })

  it('refuses --dry-run on list', async () => {
    const exitCode = await main(['list', '--host', HOST, '--limit', '1', '--dry-run'])

    expect(exitCode).toBe(2)
    expect(runList).not.toHaveBeenCalled()
  })

  it('refuses --limit on share create, naming the two-word command', async () => {
    const exitCode = await main(['share', 'create', ARTIFACT_ID, '--host', HOST, '--limit', '5'])

    expect(exitCode).toBe(2)
    expect(runShareCreate).not.toHaveBeenCalled()
    expect(stderr()).toContain("--limit is not an option for 'share create'")
  })

  it('still accepts every flag a command does declare', async () => {
    expect(await main(['list', '--host', HOST, '--limit', '2', '--cursor', 'abc', '--json'])).toBe(
      0,
    )
    expect(runList).toHaveBeenCalledTimes(1)
  })

  it('keeps --version working as share create s own option', async () => {
    const versionId = '9b1c3d4e-5555-4666-8777-888888888888'
    expect(
      await main(['share', 'create', ARTIFACT_ID, '--host', HOST, '--version', versionId]),
    ).toBe(0)
    expect(runShareCreate).toHaveBeenCalledWith(expect.objectContaining({ versionId }))
  })

  it('allows --help everywhere without listing it per command', async () => {
    expect(await main(['rm', ARTIFACT_ID, '--help'])).toBe(0)
    expect(runRemove).not.toHaveBeenCalled()
  })

  it('reports an unknown share subcommand before it reports an unknown option', async () => {
    expect(await main(['share', 'delete', ARTIFACT_ID, '--limit', '5'])).toBe(2)
    expect(stderr()).toContain("unknown share subcommand 'delete'")
  })

  it('does not treat an inherited Object member as a command', async () => {
    expect(await main(['toString'])).toBe(2)
    expect(stderr()).toContain("unknown command 'toString'")
  })
})

describe('version', () => {
  it('prints a bare line for the flag forms', async () => {
    for (const flag of ['--version', '-V', '-v']) {
      written = []
      expect(await main([flag])).toBe(0)
      expect(stdout().trim()).toBe(cliVersion())
    }
  })

  it('prints parseable JSON for --json rather than a bare string', async () => {
    expect(await main(['version', '--json'])).toBe(0)
    expect(JSON.parse(stdout()) as { version: string }).toEqual({ version: cliVersion() })
  })

  it('prints parseable JSON for the flag form too', async () => {
    expect(await main(['--version', '--json'])).toBe(0)
    expect(JSON.parse(stdout()) as { version: string }).toEqual({ version: cliVersion() })
  })

  it('rejects trailing junk rather than reporting a version for it', async () => {
    expect(await main(['version', 'extra'])).toBe(2)
  })
})

/**
 * `enclave --json` is not a request for help, it is a command name that never arrived. Answering it
 * with the banner on stdout at exit 0 tells a wrapper the run succeeded and then feeds prose to the
 * parser it promised JSON to.
 */
describe('a command name is required', () => {
  it('prints the banner to stdout at exit 0 for no arguments at all', async () => {
    expect(await main([])).toBe(0)
    expect(stdout()).toContain('enclave — publish and manage artifacts')
    expect(stderr()).toBe('')
  })

  it('prints the banner to stdout at exit 0 for --help', async () => {
    expect(await main(['--help'])).toBe(0)
    expect(stdout()).toContain('enclave — publish and manage artifacts')
  })

  it('exits 2 with nothing on stdout when flags arrive without a command', async () => {
    for (const flag of ['--json', '--insecure', '--dry-run']) {
      written = []
      writtenToStderr = []
      expect(await main([flag])).toBe(2)
      expect(stdout()).toBe('')
      expect(stderr()).toContain('no command')
    }
  })
})

/**
 * `push --help`, `rm --help` and `share create --help` were byte-identical: one 29-line synopsis
 * answering every question. `--help` is the only documentation at the terminal.
 */
describe('per-command --help', () => {
  const LABELS: readonly string[][] = [
    ['version'],
    ['login'],
    ['logout'],
    ['push'],
    ['list'],
    ['show'],
    ['rename'],
    ['privacy'],
    ['rm'],
    ['restore'],
    ['share'],
    ['share', 'create'],
    ['share', 'list'],
    ['share', 'revoke'],
  ]

  it('answers every command label on stdout without running the command', async () => {
    for (const words of LABELS) {
      written = []
      writtenToStderr = []

      expect(await main([...words, '--help'])).toBe(0)
      expect(stdout()).toContain(`enclave ${words.join(' ')} —`)
      expect(stderr()).toBe('')
    }

    expect(runList).not.toHaveBeenCalled()
    expect(runRemove).not.toHaveBeenCalled()
    expect(runShareCreate).not.toHaveBeenCalled()
  })

  it('answers push with the rules that exist nowhere else at the terminal', async () => {
    expect(await main(['push', '--help'])).toBe(0)

    const topic = stdout()
    expect(topic).toContain('index.html')
    expect(topic).toContain('--new')
    expect(topic).toContain('2 MB')
    expect(topic).toContain('--artifact')
    expect(topic).toContain('--force publishes anyway')
    expect(topic).toContain('deadLinks')
  })

  it('gives rm its own topic rather than push s', async () => {
    await main(['rm', ARTIFACT_ID, '--help'])
    const removeTopic = stdout()

    written = []
    await main(['push', './dist', '--help'])
    const pushTopic = stdout()

    expect(removeTopic).not.toContain('--dry-run')
    expect(removeTopic).not.toContain('index.html')
    expect(removeTopic).not.toBe(pushTopic)
  })

  it('keeps the banner for a command it has no topic for', async () => {
    expect(await main(['badcmd', '--help'])).toBe(0)
    expect(stdout()).toContain('enclave — publish and manage artifacts')
  })

  it('does not treat an inherited Object member as a help topic', async () => {
    expect(await main(['toString', '--help'])).toBe(0)
    expect(stdout()).toContain('enclave — publish and manage artifacts')
  })
})

describe('the usage banner documents every flag a command accepts', () => {
  it.each(['rename', 'privacy', 'rm', 'restore'])('documents --json on %s', async (command) => {
    await main(['--help'])

    const line = stdout()
      .split('\n')
      .find((candidate) => candidate.trimStart().startsWith(`enclave ${command} `))
    expect(line).toBeDefined()
    expect(line).toContain('--json')
  })
})
