import { parseArgs } from 'node:util'

import { runList, runPrivacy, runRemove, runRename, runRestore, runShow } from './commands/artifacts.ts'
import { runLogin } from './commands/login.ts'
import { runLogout } from './commands/logout.ts'
import { runPush } from './commands/push.ts'
import { runShareCreate, runShareList, runShareRevoke } from './commands/shares.ts'

const EXIT_OK = 0
const EXIT_USAGE = 2

const USAGE = `enclave — publish and manage artifacts on a self-hosted instance

  enclave login    [--host <host>]
  enclave logout   [--host <host>]

  enclave push     <dir> [--title <t>] [--visibility private|org]
                         [--new] [--dry-run] [--json]
  enclave list     [--limit <n>] [--cursor <c>] [--json]
  enclave show     <id> [--json]
  enclave rename   <id> <title>
  enclave privacy  <id> private|org
  enclave rm       <id>
  enclave restore  <id>

  enclave share create <id> [--version <versionId>] [--expires <7d|ISO>] [--json]
  enclave share list   <id> [--json]
  enclave share revoke <shareId>

Host resolution: --host, else ENCLAVE_HOST. \`push\` also falls back to .enclave.json.
Credentials: ENCLAVE_TOKEN, else ~/.config/enclave/credentials.json.
`

const OPTION_CONFIG = {
  host: { type: 'string' },
  title: { type: 'string' },
  visibility: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  version: { type: 'string' },
  expires: { type: 'string' },
  new: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const

function usage(message?: string): number {
  if (message !== undefined) process.stderr.write(`${message}\n\n`)
  process.stdout.write(USAGE)
  return message === undefined ? EXIT_OK : EXIT_USAGE
}

/** `push` is the exception: it can recover a host from .enclave.json, so it resolves its own. */
function requireHost(flag: string | undefined): string {
  const host = flag ?? process.env['ENCLAVE_HOST']
  if (host === undefined || host === '') {
    throw new UsageError('no host — pass --host or set ENCLAVE_HOST')
  }
  return host
}

class UsageError extends Error {}

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index]
  if (value === undefined || value === '') throw new UsageError(`missing <${name}>`)
  return value
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--limit must be a positive integer, got '${raw}'`)
  return parsed
}

async function runShare(
  positionals: readonly string[],
  values: { host?: string; version?: string; expires?: string; json: boolean },
): Promise<number> {
  const subcommand = positionals[1]

  if (subcommand === 'create') {
    const id = requirePositional(positionals, 2, 'id')
    return runShareCreate({
      host: requireHost(values.host),
      id,
      isJson: values.json,
      ...(values.version === undefined ? {} : { versionId: values.version }),
      ...(values.expires === undefined ? {} : { expires: values.expires }),
    })
  }
  if (subcommand === 'list') {
    return runShareList({
      host: requireHost(values.host),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
    })
  }
  if (subcommand === 'revoke') {
    return runShareRevoke({
      host: requireHost(values.host),
      shareId: requirePositional(positionals, 2, 'shareId'),
    })
  }
  throw new UsageError(`unknown share subcommand '${subcommand ?? ''}' — expected create, list or revoke`)
}

export async function main(argv: readonly string[]): Promise<number> {
  let values: {
    host?: string
    title?: string
    visibility?: string
    limit?: string
    cursor?: string
    version?: string
    expires?: string
    new: boolean
    'dry-run': boolean
    json: boolean
    help: boolean
  }
  let positionals: string[]

  try {
    const parsed = parseArgs({ args: [...argv], options: OPTION_CONFIG, allowPositionals: true })
    values = parsed.values
    positionals = parsed.positionals
  } catch (error) {
    return usage(error instanceof Error ? error.message : 'could not parse the arguments')
  }

  const command = positionals[0]
  if (values.help || command === undefined) return usage()

  try {
    switch (command) {
      case 'login':
        return await runLogin(requireHost(values.host))
      case 'logout':
        return runLogout(requireHost(values.host))
      case 'push':
        return await runPush({
          directory: requirePositional(positionals, 1, 'dir'),
          isNew: values.new,
          isDryRun: values['dry-run'],
          isJson: values.json,
          ...(values.host === undefined ? {} : { host: values.host }),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(values.visibility === undefined
            ? {}
            : { visibility: values.visibility as 'private' | 'org' }),
        })
      case 'list': {
        const limit = parseLimit(values.limit)
        return await runList({
          host: requireHost(values.host),
          isJson: values.json,
          ...(limit === undefined ? {} : { limit }),
          ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
        })
      }
      case 'show':
        return await runShow({
          host: requireHost(values.host),
          id: requirePositional(positionals, 1, 'id'),
          isJson: values.json,
        })
      case 'rename':
        return await runRename({
          host: requireHost(values.host),
          id: requirePositional(positionals, 1, 'id'),
          title: requirePositional(positionals, 2, 'title'),
          isJson: values.json,
        })
      case 'privacy':
        return await runPrivacy({
          host: requireHost(values.host),
          id: requirePositional(positionals, 1, 'id'),
          visibility: requirePositional(positionals, 2, 'visibility'),
          isJson: values.json,
        })
      case 'rm':
        return await runRemove({
          host: requireHost(values.host),
          id: requirePositional(positionals, 1, 'id'),
          isJson: values.json,
        })
      case 'restore':
        return await runRestore({
          host: requireHost(values.host),
          id: requirePositional(positionals, 1, 'id'),
          isJson: values.json,
        })
      case 'share':
        return await runShare(positionals, values)
      default:
        return usage(`unknown command '${command}'`)
    }
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message)
    throw error
  }
}
