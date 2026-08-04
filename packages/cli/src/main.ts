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

const USAGE = `enclave — publish and manage artifacts on a self-hosted instance

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

  enclave share create <id> [--version <versionId>] [--expires <7d|2026-08-10T23:59:00+07:00>] [--json]
  enclave share list   <id> [--json]
  enclave share revoke <shareId>

Host resolution: --host, else ENCLAVE_HOST. \`push\` also falls back to .enclave.json.
Credentials: ENCLAVE_TOKEN, else ~/.config/enclave/credentials.json.

--expires takes a duration (7d, 12h, 2w); a date (2026-08-10) or a date-time (2026-08-10T14:30),
both resolved in this machine's local timezone; or an ISO-8601 instant with an explicit zone
(2026-08-10T23:59:00+07:00, 2026-08-10T16:59:00Z), taken exactly as given. Anything else is refused.

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
  const host = flag ?? process.env['ENCLAVE_HOST']
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
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
      ...(values.version === undefined ? {} : { versionId: values.version }),
      ...(values.expires === undefined ? {} : { expires: values.expires }),
    }),
  list: (positionals, values) =>
    runShareList({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 2, 'id'),
      isJson: values.json,
    }),
  revoke: (positionals, values) =>
    runShareRevoke({
      host: requireHost(values.host, values.insecure),
      shareId: requirePositional(positionals, 2, 'shareId'),
    }),
}

/** Every command takes the same two arguments, which is what lets this be a table and not a switch. */
const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  login: (_positionals, values) =>
    runLogin(requireHost(values.host, values.insecure), values.token, values.insecure),

  logout: (_positionals, values) => runLogout(requireHost(values.host, values.insecure)),

  push: (positionals, values) =>
    runPush({
      directory: requirePositional(positionals, 1, 'dir'),
      isNew: values.new,
      isDryRun: values['dry-run'],
      isJson: values.json,
      isInsecureAllowed: values.insecure,
      ...(values.host === undefined ? {} : { host: values.host }),
      ...(values.title === undefined ? {} : { title: values.title }),
      ...(values.visibility === undefined
        ? {}
        : { visibility: values.visibility as 'private' | 'org' }),
    }),

  list: (_positionals, values) => {
    const limit = parseLimit(values.limit)
    return runList({
      host: requireHost(values.host, values.insecure),
      isJson: values.json,
      ...(limit === undefined ? {} : { limit }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
    })
  },

  show: (positionals, values) =>
    runShow({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
    }),

  rename: (positionals, values) =>
    runRename({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      title: requirePositional(positionals, 2, 'title'),
      isJson: values.json,
    }),

  privacy: (positionals, values) =>
    runPrivacy({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      visibility: requirePositional(positionals, 2, 'visibility'),
      isJson: values.json,
    }),

  rm: (positionals, values) =>
    runRemove({
      host: requireHost(values.host, values.insecure),
      id: requirePositional(positionals, 1, 'id'),
      isJson: values.json,
    }),

  restore: (positionals, values) =>
    runRestore({
      host: requireHost(values.host, values.insecure),
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
