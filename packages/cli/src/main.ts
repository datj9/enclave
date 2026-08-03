import { parseArgs } from 'node:util'

import { InvalidHostError, normaliseHost } from '../../push-core/src/index.ts'

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
import { cliVersion } from './version.ts'

const USAGE = `enclave — publish and manage artifacts on a self-hosted instance

  enclave version
  enclave login    [--host <host>] [--token <token>]
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

--insecure allows an explicit http:// host that isn't loopback (localhost, 127.0.0.1, [::1]).
Without it, a non-loopback http host is refused rather than sending a token in cleartext.
`

const OPTION_CONFIG = {
  host: { type: 'string' },
  token: { type: 'string' },
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
  insecure: { type: 'boolean', default: false },
} as const

interface ParsedValues {
  readonly host?: string
  readonly token?: string
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
  readonly insecure: boolean
}

type CommandHandler = (
  positionals: readonly string[],
  values: ParsedValues,
) => Promise<number> | number

class UsageError extends Error {}

/**
 * `--help` is the answer to a question, so it goes to stdout. A usage error is a diagnostic and
 * goes wholly to stderr — printing the banner on stdout would break `enclave … --json | jq` the
 * same way a stray error line does.
 */
function usage(message?: string): number {
  if (message === undefined) {
    process.stdout.write(USAGE)
    return EXIT_OK
  }
  process.stderr.write(`${message}\n\n${USAGE}`)
  return EXIT_USAGE
}

/** `push` is the exception: it recovers a host from .enclave.json, so it resolves its own. */
function requireHost(flag: string | undefined, isInsecureAllowed: boolean): string {
  const fromFlag = flag?.trim()
  const fromEnv = process.env['ENCLAVE_HOST']?.trim()
  const host = fromFlag !== undefined && fromFlag !== '' ? fromFlag : fromEnv
  if (host === undefined || host === '') {
    throw new UsageError('no host — pass --host or set ENCLAVE_HOST')
  }
  try {
    return normaliseHost(host, isInsecureAllowed)
  } catch (error) {
    if (error instanceof InvalidHostError) throw new UsageError(error.message)
    throw error
  }
}

function requirePositional(positionals: readonly string[], index: number, name: string): string {
  const value = positionals[index]
  if (value === undefined || value === '') throw new UsageError(`missing <${name}>`)
  return value
}

/** Reject trailing junk so `share create <id> EXTRA` cannot mint a credential while discarding input. */
function requireArity(positionals: readonly string[], maxIndex: number): void {
  if (positionals.length > maxIndex + 1) {
    throw new UsageError(`unexpected argument '${positionals[maxIndex + 1] ?? ''}'`)
  }
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`--limit must be a positive integer, got '${raw}'`)
  }
  return parsed
}

function parseVisibility(raw: string | undefined): 'private' | 'org' | undefined {
  if (raw === undefined) return undefined
  if (raw === 'private' || raw === 'org') return raw
  throw new UsageError(`--visibility must be private or org, got '${raw}'`)
}

/**
 * Global version only in unambiguous positions — never `argv.includes('--version')`, which would
 * steal `share create --version <id>`.
 */
function isGlobalVersionRequest(argv: readonly string[]): boolean {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) return true
  if (argv.length === 1 && argv[0] === 'version') return true
  if (argv.length === 2 && argv[0] === 'version' && (argv[1] === '--json' || argv[1] === '-V')) {
    return true
  }
  return false
}

const SHARE_HANDLERS: Readonly<Record<string, CommandHandler>> = {
  create: (positionals, values) => {
    requireArity(positionals, 2)
    return runShareCreate({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
      ...(values.version === undefined ? {} : { versionId: values.version }),
      ...(values.expires === undefined ? {} : { expires: values.expires }),
    })
  },
  list: (positionals, values) => {
    requireArity(positionals, 2)
    return runShareList({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
    })
  },
  revoke: (positionals, values) => {
    requireArity(positionals, 2)
    return runShareRevoke({
      host: requireHost(values.host, values.insecure),
      shareId: requirePositional(positionals, 2, 'shareId'),
      isInsecureAllowed: values.insecure,
    })
  },
}

/** Every command takes the same two arguments, which is what lets this be a table and not a switch. */
const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  version: (positionals) => {
    requireArity(positionals, 0)
    process.stdout.write(`${cliVersion()}\n`)
    return EXIT_OK
  },

  login: (positionals, values) => {
    requireArity(positionals, 0)
    return runLogin(requireHost(values.host, values.insecure), values.token, values.insecure)
  },

  logout: (positionals, values) => {
    requireArity(positionals, 0)
    return runLogout(requireHost(values.host, values.insecure))
  },

  push: (positionals, values) => {
    requireArity(positionals, 1)
    const visibility = parseVisibility(values.visibility)
    return runPush({
      directory: requirePositional(positionals, 1, 'dir'),
      isNew: values.new,
      isDryRun: values['dry-run'],
      isJson: values.json,
      isInsecureAllowed: values.insecure,
      ...(values.host === undefined || values.host.trim() === '' ? {} : { host: values.host }),
      ...(values.title === undefined ? {} : { title: values.title }),
      ...(visibility === undefined ? {} : { visibility }),
    })
  },

  list: (positionals, values) => {
    requireArity(positionals, 0)
    const limit = parseLimit(values.limit)
    return runList({
      host: requireHost(values.host, values.insecure),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
      ...(limit === undefined ? {} : { limit }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
    })
  },

  show: (positionals, values) => {
    requireArity(positionals, 1)
    return runShow({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
    })
  },

  rename: (positionals, values) => {
    requireArity(positionals, 2)
    return runRename({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      title: requirePositional(positionals, 2, 'title'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
    })
  },

  privacy: (positionals, values) => {
    requireArity(positionals, 2)
    return runPrivacy({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      visibility: requirePositional(positionals, 2, 'visibility'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
    })
  },

  rm: (positionals, values) => {
    requireArity(positionals, 1)
    return runRemove({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
    })
  },

  restore: (positionals, values) => {
    requireArity(positionals, 1)
    return runRestore({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
      isInsecureAllowed: values.insecure,
    })
  },

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
  if (isGlobalVersionRequest(argv)) {
    process.stdout.write(`${cliVersion()}\n`)
    return EXIT_OK
  }

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
