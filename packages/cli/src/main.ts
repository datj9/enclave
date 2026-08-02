import { parseArgs } from 'node:util'

import {
  runList,
  runPrivacy,
  runRemove,
  runRename,
  runRestore,
  runShow,
} from './commands/artifacts.ts'
import { runLogin } from './commands/login.ts'
import { runLogout } from './commands/logout.ts'
import { runPush } from './commands/push.ts'
import { runShareCreate, runShareList, runShareRevoke } from './commands/shares.ts'
import { EXIT_OK, EXIT_USAGE } from './exit-codes.ts'

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

interface ParsedValues {
  readonly host?: string
  readonly title?: string
  readonly visibility?: string
  readonly limit?: string
  readonly cursor?: string
  readonly version?: string
  readonly expires?: string
  readonly new: boolean
  readonly 'dry-run': boolean
  readonly json: boolean
  readonly help: boolean
}

type CommandHandler = (
  positionals: readonly string[],
  values: ParsedValues,
) => Promise<number> | number

class UsageError extends Error {}

function usage(message?: string): number {
  if (message !== undefined) process.stderr.write(`${message}\n\n`)
  process.stdout.write(USAGE)
  return message === undefined ? EXIT_OK : EXIT_USAGE
}

/** `push` is the exception: it recovers a host from .enclave.json, so it resolves its own. */
function requireHost(flag: string | undefined): string {
  const host = flag ?? process.env['ENCLAVE_HOST']
  if (host === undefined || host === '') {
    throw new UsageError('no host — pass --host or set ENCLAVE_HOST')
  }
  return host
}

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index]
  if (value === undefined || value === '') throw new UsageError(`missing <${name}>`)
  return value
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`--limit must be a positive integer, got '${raw}'`)
  }
  return parsed
}

const SHARE_HANDLERS: Readonly<Record<string, CommandHandler>> = {
  create: (positionals, values) =>
    runShareCreate({
      host: requireHost(values.host),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
      ...(values.version === undefined ? {} : { versionId: values.version }),
      ...(values.expires === undefined ? {} : { expires: values.expires }),
    }),
  list: (positionals, values) =>
    runShareList({
      host: requireHost(values.host),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
    }),
  revoke: (positionals, values) =>
    runShareRevoke({
      host: requireHost(values.host),
      shareId: requirePositional(positionals, 2, 'shareId'),
    }),
}

/** Every command takes the same two arguments, which is what lets this be a table and not a switch. */
const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  login: (_positionals, values) => runLogin(requireHost(values.host)),

  logout: (_positionals, values) => runLogout(requireHost(values.host)),

  push: (positionals, values) =>
    runPush({
      directory: requirePositional(positionals, 1, 'dir'),
      isNew: values.new,
      isDryRun: values['dry-run'],
      isJson: values.json,
      ...(values.host === undefined ? {} : { host: values.host }),
      ...(values.title === undefined ? {} : { title: values.title }),
      ...(values.visibility === undefined
        ? {}
        : { visibility: values.visibility as 'private' | 'org' }),
    }),

  list: (_positionals, values) => {
    const limit = parseLimit(values.limit)
    return runList({
      host: requireHost(values.host),
      isJson: values.json,
      ...(limit === undefined ? {} : { limit }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
    })
  },

  show: (positionals, values) =>
    runShow({
      host: requireHost(values.host),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
    }),

  rename: (positionals, values) =>
    runRename({
      host: requireHost(values.host),
      id: requirePositional(positionals, 1, 'id'),
      title: requirePositional(positionals, 2, 'title'),
      isJson: values.json,
    }),

  privacy: (positionals, values) =>
    runPrivacy({
      host: requireHost(values.host),
      id: requirePositional(positionals, 1, 'id'),
      visibility: requirePositional(positionals, 2, 'visibility'),
      isJson: values.json,
    }),

  rm: (positionals, values) =>
    runRemove({
      host: requireHost(values.host),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
    }),

  restore: (positionals, values) =>
    runRestore({
      host: requireHost(values.host),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
    }),

  share: (positionals, values) => {
    const subcommand = positionals[1] ?? ''
    const handler = SHARE_HANDLERS[subcommand]
    if (handler === undefined) {
      throw new UsageError(
        `unknown share subcommand '${subcommand}' — expected create, list or revoke`,
      )
    }
    return handler(positionals, values)
  },
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: { values: ParsedValues; positionals: string[] }
  try {
    parsed = parseArgs({ args: [...argv], options: OPTION_CONFIG, allowPositionals: true })
  } catch (error) {
    return usage(error instanceof Error ? error.message : 'could not parse the arguments')
  }

  const { values, positionals } = parsed
  const command = positionals[0]
  if (values.help || command === undefined) return usage()

  const handler = COMMANDS[command]
  if (handler === undefined) return usage(`unknown command '${command}'`)

  try {
    return await handler(positionals, values)
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message)
    throw error
  }
}
