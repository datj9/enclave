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
import { CliError, reportFailure } from './errors.ts'
import { EXIT_OK, EXIT_USAGE, type ExitCode } from './exit-codes.ts'
import { HELP_BY_LABEL } from './help.ts'
import {
  printDiagnostic,
  printJson,
  printLine,
  processContext,
  type CliContext,
  type Environment,
} from './output.ts'
import { cliVersion, UNKNOWN_VERSION } from './version.ts'

const USAGE = `enclave — publish and manage artifacts on a self-hosted instance

  enclave version  [--json]              (also -v, -V, --version)
  enclave login    [--host <host>] [--token <token>]
  enclave logout   [--host <host>]

  enclave push     <dir> [--title <t>] [--visibility private|org|public]
                         [--artifact <id>] [--new] [--force] [--dry-run] [--json]
  enclave list     [--limit <n>] [--cursor <c>] [--json]
  enclave show     <id> [--json]
  enclave rename   <id> <title> [--json]
  enclave privacy  <id> private|org|public [--json]
  enclave rm       <id> [--json]
  enclave restore  <id> [--json]

  enclave share create <id> [--version <versionId>] [--expires <7d|2026-08-10T23:59:00+07:00>] [--json]
  enclave share list   <id> [--json]
  enclave share revoke <shareId> [--artifact <id>]

Per-command detail, including what a bundle may contain: enclave <command> --help

Host resolution: --host, else ENCLAVE_HOST. \`push\` also falls back to .enclave.json.
Credentials: ENCLAVE_TOKEN, else ~/.config/enclave/credentials.json.

--expires takes a duration (7d, 12h, 2w); a date (2026-08-10) or a date-time (2026-08-10T14:30),
both resolved in this machine's local timezone (a bare date means local end of day, not UTC
midnight); or an ISO-8601 instant with an explicit zone (2026-08-10T23:59:00+07:00,
2026-08-10T16:59:00Z), taken exactly as given. Anything else is refused.

--insecure allows an explicit http:// host that isn't loopback (localhost, 127.0.0.1, [::1]).
Without it, a non-loopback http host is refused rather than sending a token in cleartext.
`

const OPTION_CONFIG = {
  host: { type: 'string' },
  token: { type: 'string' },
  title: { type: 'string' },
  visibility: { type: 'string' },
  artifact: { type: 'string' },
  limit: { type: 'string' },
  cursor: { type: 'string' },
  version: { type: 'string' },
  expires: { type: 'string' },
  new: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
  insecure: { type: 'boolean', default: false },
} as const

type OptionConfig = typeof OPTION_CONFIG
type OptionName = keyof OptionConfig
type OptionValue<Name extends OptionName> = OptionConfig[Name]['type'] extends 'boolean'
  ? boolean
  : string

/**
 * Derived from OPTION_CONFIG rather than copied beside it, so a new flag cannot be declared in one
 * and forgotten in the other. A flag with a `default` is always present; the rest may be absent.
 */
type ParsedValues = {
  readonly [
    Name in OptionName as OptionConfig[Name] extends { default: unknown } ? Name : never
  ]: OptionValue<Name>
} & {
  readonly [
    Name in OptionName as OptionConfig[Name] extends { default: unknown } ? never : Name
  ]?: OptionValue<Name>
}

type CommandHandler = (
  positionals: readonly string[],
  values: ParsedValues,
  ctx: CliContext,
) => Promise<ExitCode> | ExitCode

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
function usage(ctx: CliContext, message?: string): ExitCode {
  if (message === undefined) {
    ctx.stdout.write(USAGE)
    return EXIT_OK
  }
  printDiagnostic(ctx, `${message}\n\n${USAGE}`.trimEnd())
  return EXIT_USAGE
}

/** `push` is the exception: it recovers a host from .enclave.json, so it resolves its own. */
function requireHost(
  flag: string | undefined,
  isInsecureAllowed: boolean,
  env: Environment,
): string {
  const fromFlag = flag?.trim()
  const fromEnv = env['ENCLAVE_HOST']?.trim()
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

interface NetworkContext {
  readonly host: string
  readonly isInsecureAllowed: boolean
}

/** The host and transport every network command shares, resolved the one way they all agree on. */
function networkContext(values: ParsedValues, ctx: CliContext): NetworkContext {
  return {
    host: requireHost(values.host, values.insecure, ctx.env),
    isInsecureAllowed: values.insecure,
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

function parseVisibility(raw: string | undefined): 'private' | 'org' | 'public' | undefined {
  if (raw === undefined) return undefined
  if (raw === 'private' || raw === 'org' || raw === 'public') return raw
  throw new UsageError(`--visibility must be private, org, or public, got '${raw}'`)
}

/** `--json` has a consumer, so the version has to be an object there and a bare line otherwise. */
function writeVersion(ctx: CliContext, isJson: boolean): ExitCode {
  const version = cliVersion()
  if (version === UNKNOWN_VERSION) {
    printDiagnostic(ctx, 'could not read the CLI package.json — reporting an unknown version')
  }
  if (isJson) printJson(ctx, { version })
  else printLine(ctx, version)
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
    run: (positionals, values, ctx) => {
      requireArity(positionals, 2)
      return runShareCreate(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 2, 'id'),
          isJson: values.json,
          ...(values.version === undefined ? {} : { versionId: values.version }),
          ...(values.expires === undefined ? {} : { expires: values.expires }),
        },
        ctx,
      )
    },
  },
  list: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 2)
      return runShareList(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 2, 'id'),
          isJson: values.json,
        },
        ctx,
      )
    },
  },
  revoke: {
    options: [...NETWORK_OPTIONS, 'artifact'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 2)
      return runShareRevoke(
        {
          ...networkContext(values, ctx),
          shareId: requirePositional(positionals, 2, 'shareId'),
          ...(values.artifact === undefined ? {} : { artifactRef: values.artifact }),
        },
        ctx,
      )
    },
  },
}

/** Every command takes the same three arguments, which is what lets this be a table and not a switch. */
const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  version: {
    options: ['json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 0)
      return writeVersion(ctx, values.json)
    },
  },

  login: {
    options: [...NETWORK_OPTIONS, 'token'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 0)
      return runLogin(
        {
          ...networkContext(values, ctx),
          ...(values.token === undefined ? {} : { token: values.token }),
        },
        ctx,
      )
    },
  },

  logout: {
    options: [...NETWORK_OPTIONS],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 0)
      return runLogout(networkContext(values, ctx).host, ctx)
    },
  },

  push: {
    options: [
      ...NETWORK_OPTIONS,
      'title',
      'visibility',
      'artifact',
      'new',
      'force',
      'dry-run',
      'json',
    ],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 1)
      const visibility = parseVisibility(values.visibility)
      // Not `networkContext`: push falls back to the host in .enclave.json, so it resolves its own.
      return runPush(
        {
          directory: requirePositional(positionals, 1, 'dir'),
          isNew: values.new,
          isForced: values.force,
          isDryRun: values['dry-run'],
          isJson: values.json,
          isInsecureAllowed: values.insecure,
          ...(values.host === undefined || values.host.trim() === '' ? {} : { host: values.host }),
          ...(values.title === undefined ? {} : { title: values.title }),
          ...(visibility === undefined ? {} : { visibility }),
          ...(values.artifact === undefined ? {} : { artifactRef: values.artifact }),
        },
        ctx,
      )
    },
  },

  list: {
    options: [...NETWORK_OPTIONS, 'limit', 'cursor', 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 0)
      const limit = parseLimit(values.limit)
      return runList(
        {
          ...networkContext(values, ctx),
          isJson: values.json,
          ...(limit === undefined ? {} : { limit }),
          ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
        },
        ctx,
      )
    },
  },

  show: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 1)
      return runShow(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 1, 'id'),
          isJson: values.json,
        },
        ctx,
      )
    },
  },

  rename: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 2)
      return runRename(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 1, 'id'),
          title: requirePositional(positionals, 2, 'title'),
          isJson: values.json,
        },
        ctx,
      )
    },
  },

  privacy: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 2)
      return runPrivacy(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 1, 'id'),
          visibility: requirePositional(positionals, 2, 'visibility'),
          isJson: values.json,
        },
        ctx,
      )
    },
  },

  rm: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 1)
      return runRemove(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 1, 'id'),
          isJson: values.json,
        },
        ctx,
      )
    },
  },

  restore: {
    options: [...NETWORK_OPTIONS, 'json'],
    run: (positionals, values, ctx) => {
      requireArity(positionals, 1)
      return runRestore(
        {
          ...networkContext(values, ctx),
          id: requirePositional(positionals, 1, 'id'),
          isJson: values.json,
        },
        ctx,
      )
    },
  },
}

/** `share` is the only two-word command, so the label doubles as the option-table key. */
function commandLabel(positionals: readonly string[]): string {
  const command = positionals[0] ?? ''
  return command === 'share' ? `share ${positionals[1] ?? ''}`.trim() : command
}

/**
 * Resolved before `specFor`, which is what keeps `enclave share --help` on the share topic rather
 * than the exit-2 unknown-subcommand refusal that would otherwise reach it first. Own-property
 * lookups only, for the same reason `specFor` uses them: `toString` is not a command.
 */
function helpFor(ctx: CliContext, positionals: readonly string[]): ExitCode {
  const label = commandLabel(positionals)
  if (!Object.hasOwn(HELP_BY_LABEL, label)) return usage(ctx)
  ctx.stdout.write(HELP_BY_LABEL[label] ?? '')
  return EXIT_OK
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

function rejectForeignOptions(supplied: readonly string[], spec: CommandSpec, label: string): void {
  const permitted = new Set<string>([...spec.options, ALWAYS_ALLOWED_OPTION])
  for (const name of supplied) {
    if (!permitted.has(name)) {
      throw new UsageError(`--${name} is not an option for '${label}'`)
    }
  }
}

/**
 * A command that takes `--json` and was given it answers a malformed invocation with the same
 * `{"error":{…}}` envelope as any other failure, so a script parses one shape on every path. The
 * banner is for a human; it would be noise in front of a parser.
 */
function refuseUsage(
  ctx: CliContext,
  message: string,
  spec: CommandSpec | undefined,
  values: ParsedValues,
): ExitCode {
  const isJson = values.json && spec?.options.includes('json') === true
  if (!isJson) return usage(ctx, message)
  return reportFailure(new CliError('USAGE_ERROR', message, { exitCode: EXIT_USAGE }), ctx, {
    isJson,
  })
}

export async function main(
  argv: readonly string[],
  ctx: CliContext = processContext(),
): Promise<ExitCode> {
  const versionRequest = globalVersionRequest(argv)
  if (versionRequest !== null) return writeVersion(ctx, versionRequest.isJson)

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
    return usage(ctx, error instanceof Error ? error.message : 'could not parse the arguments')
  }

  const { values, positionals, tokens } = parsed
  const command = positionals[0]
  // Flags with no command are a malformed invocation, not a request for help: answering on stdout
  // at exit 0 tells `enclave --json | jq` the run succeeded and then hands the parser prose.
  if (command === undefined) {
    if (values.help || argv.length === 0) return usage(ctx)
    return usage(ctx, 'no command — see the commands above')
  }
  if (values.help) return helpFor(ctx, positionals)

  let spec: CommandSpec | undefined
  try {
    spec = specFor(positionals)
    if (spec === undefined) return usage(ctx, `unknown command '${command}'`)
    rejectForeignOptions(suppliedOptions(tokens), spec, commandLabel(positionals))
    return await spec.run(positionals, values, ctx)
  } catch (error) {
    if (error instanceof UsageError) return refuseUsage(ctx, error.message, spec, values)
    throw error
  }
}
