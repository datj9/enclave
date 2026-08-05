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
import { cliVersion, UNKNOWN_VERSION } from './version.ts'

const USAGE = `enclave — publish and manage artifacts on a self-hosted instance

  enclave version  [--json]              (also -v, -V, --version)
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

/**
 * `options` is the closed set of flags a command accepts, `--help` aside. Without it `parseArgs`
 * applies every declared flag to every command, so `rm <id> --dry-run` deletes the artifact while
 * reading to the user as a rehearsal.
 */
interface CommandSpec {
  readonly options: readonly string[]
  readonly run: CommandHandler
}

const ALWAYS_ALLOWED_OPTION = 'help'

/** Every command that reaches the network resolves a host and may need to allow plain http. */
const NETWORK_OPTIONS = ['host', 'insecure'] as const

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

/** `--json` has a consumer, so the version has to be an object there and a bare line otherwise. */
function writeVersion(isJson: boolean): number {
  const version = cliVersion()
  if (version === UNKNOWN_VERSION) {
    process.stderr.write(
      'could not read the CLI package.json — reporting an unknown version\n',
    )
  }
  process.stdout.write(isJson ? `${JSON.stringify({ version })}\n` : `${version}\n`)
  return EXIT_OK
}

const VERSION_FLAGS = new Set(['--version', '-V', '-v'])

/**
 * The version *flags* are handled before `parseArgs` because they are not declared options — but
 * only in unambiguous leading positions. Never `argv.includes('--version')`, which would steal
 * `share create <id> --version <uuid>`. Bare `enclave version` is an ordinary command.
 */
function globalVersionRequest(argv: readonly string[]): { readonly isJson: boolean } | null {
  const [first, second, ...rest] = argv
  if (first === undefined || !VERSION_FLAGS.has(first)) return null
  if (second === undefined) return { isJson: false }
  if (second === '--json' && rest.length === 0) return { isJson: true }
  return null
}

const SHARE_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  create: {
    options: [...NETWORK_OPTIONS, 'version', 'expires', 'json'],
    run: (positionals, values) => {
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
  },
  list: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values) => {
      requireArity(positionals, 2)
      return runShareList({
        host: requireHost(values.host, values.insecure),
        id: requirePositional(positionals, 2, 'id'),
        isJson: values.json,
        isInsecureAllowed: values.insecure,
      })
    },
  },
  revoke: {
    options: [...NETWORK_OPTIONS],
    run: (positionals, values) => {
      requireArity(positionals, 2)
      return runShareRevoke({
        host: requireHost(values.host, values.insecure),
        shareId: requirePositional(positionals, 2, 'shareId'),
        isInsecureAllowed: values.insecure,
      })
    },
  },
}

/** Every command takes the same two arguments, which is what lets this be a table and not a switch. */
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  version: {
    options: ['json'],
    run: (positionals, values) => {
      requireArity(positionals, 0)
      return writeVersion(values.json)
    },
  },

  login: {
    options: [...NETWORK_OPTIONS, 'token'],
    run: (positionals, values) => {
      requireArity(positionals, 0)
      return runLogin(requireHost(values.host, values.insecure), values.token, values.insecure)
    },
  },

  logout: {
    options: [...NETWORK_OPTIONS],
    run: (positionals, values) => {
      requireArity(positionals, 0)
      return runLogout(requireHost(values.host, values.insecure))
    },
  },

  push: {
    options: [...NETWORK_OPTIONS, 'title', 'visibility', 'new', 'dry-run', 'json'],
    run: (positionals, values) => {
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
  },

  list: {
    options: [...NETWORK_OPTIONS, 'limit', 'cursor', 'json'],
    run: (positionals, values) => {
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
  },

  show: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values) => {
      requireArity(positionals, 1)
      return runShow({
        host: requireHost(values.host, values.insecure),
        id: requirePositional(positionals, 1, 'id'),
        isJson: values.json,
        isInsecureAllowed: values.insecure,
      })
    },
  },

  rename: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values) => {
      requireArity(positionals, 2)
      return runRename({
        host: requireHost(values.host, values.insecure),
        id: requirePositional(positionals, 1, 'id'),
        title: requirePositional(positionals, 2, 'title'),
        isJson: values.json,
        isInsecureAllowed: values.insecure,
      })
    },
  },

  privacy: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values) => {
      requireArity(positionals, 2)
      return runPrivacy({
        host: requireHost(values.host, values.insecure),
        id: requirePositional(positionals, 1, 'id'),
        visibility: requirePositional(positionals, 2, 'visibility'),
        isJson: values.json,
        isInsecureAllowed: values.insecure,
      })
    },
  },

  rm: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values) => {
      requireArity(positionals, 1)
      return runRemove({
        host: requireHost(values.host, values.insecure),
        id: requirePositional(positionals, 1, 'id'),
        isJson: values.json,
        isInsecureAllowed: values.insecure,
      })
    },
  },

  restore: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values) => {
      requireArity(positionals, 1)
      return runRestore({
        host: requireHost(values.host, values.insecure),
        id: requirePositional(positionals, 1, 'id'),
        isJson: values.json,
        isInsecureAllowed: values.insecure,
      })
    },
  },
}

/** `share` is the only two-word command, so the label doubles as the option-table key. */
function commandLabel(positionals: readonly string[]): string {
  const command = positionals[0] ?? ''
  return command === 'share' ? `share ${positionals[1] ?? ''}`.trim() : command
}

/** Own-property lookups only: inherited members like `toString` are not commands. */
function specFor(positionals: readonly string[]): CommandSpec | undefined {
  const command = positionals[0]
  if (command === undefined) return undefined
  if (command !== 'share') {
    return Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined
  }

  const subcommand = positionals[1] ?? ''
  if (!Object.hasOwn(SHARE_COMMANDS, subcommand)) {
    throw new UsageError(
      `unknown share subcommand '${subcommand}' — expected create, list or revoke`,
    )
  }
  return SHARE_COMMANDS[subcommand]
}

interface OptionToken {
  readonly kind: string
  readonly name?: string
}

function suppliedOptions(tokens: readonly OptionToken[]): readonly string[] {
  return tokens.flatMap((token) =>
    token.kind === 'option' && token.name !== undefined ? [token.name] : [],
  )
}

function rejectForeignOptions(
  supplied: readonly string[],
  spec: CommandSpec,
  label: string,
): void {
  const permitted = new Set<string>([...spec.options, ALWAYS_ALLOWED_OPTION])
  for (const name of supplied) {
    if (!permitted.has(name)) {
      throw new UsageError(`--${name} is not an option for '${label}'`)
    }
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const versionRequest = globalVersionRequest(argv)
  if (versionRequest !== null) return writeVersion(versionRequest.isJson)

  let parsed: {
    values: ParsedValues
    positionals: readonly string[]
    tokens: readonly OptionToken[]
  }
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTION_CONFIG,
      allowPositionals: true,
      tokens: true,
    })
  } catch (error) {
    return usage(error instanceof Error ? error.message : 'could not parse the arguments')
  }

  const { values, positionals, tokens } = parsed
  const command = positionals[0]
  if (values.help || command === undefined) return usage()

  try {
    const spec = specFor(positionals)
    if (spec === undefined) return usage(`unknown command '${command}'`)
    rejectForeignOptions(suppliedOptions(tokens), spec, commandLabel(positionals))
    return await spec.run(positionals, values)
  } catch (error) {
    if (error instanceof UsageError) return usage(error.message)
    throw error
  }
}
