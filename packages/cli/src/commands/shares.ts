import type { ApiClient } from '../api-client.ts'
import { requireClient } from '../auth.ts'
import { CliError, invalidArgument, reportFailure, type FailureContext } from '../errors.ts'
import { EXIT_OK, EXIT_USAGE, type ExitCode } from '../exit-codes.ts'
import { MIN_PREFIX_LENGTH, resolveArtifactId, shortId } from '../ids.ts'
import { printDiagnostic, printJson, printLine, type CliContext } from '../output.ts'

/**
 * `enclave share create|list|revoke` (S20). A share URL is a bearer capability: it is printed to
 * stdout and nowhere else — never written to the state file, never attached to an error, never
 * echoed back by `list`, which projects its own columns rather than dumping the response.
 */

const REQUIRED_SCOPE = 'shares:write'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARE_PREFIX_PATTERN = /^[0-9a-f]{8,}$/i
const RELATIVE_EXPIRY_PATTERN = /^(\d+)([hdw])$/i
const ISO_DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
// Fractional seconds match Zod/RFC 3339 (unlimited digits): Python/Go often emit 6.
const ISO_ZONELESS_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const ISO_ZONED_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/
const HOURS_PER_UNIT: Readonly<Record<string, number>> = { h: 1, d: 24, w: 168 }
const MILLISECONDS_PER_HOUR = 3_600_000
/** ECMAScript Date absolute range (±100_000_000 days from epoch). */
const MAX_DATE_MILLISECONDS = 8.64e15

/** Every rejection names all four shapes: "ISO" on its own is the wording that caused the defect. */
const EXPIRY_SHAPES =
  'a duration like 7d, 12h or 2w, a date like 2026-08-10, a date-time like 2026-08-10T14:30, ' +
  'or an ISO-8601 instant with an explicit zone such as 2026-08-10T23:59:00+07:00 or ' +
  '2026-08-10T16:59:00Z'

const EXPIRES_COLUMN_WIDTH = 24
const NEVER = 'never'

/** `token` is readable exactly once — `src/lib/shares/manage.ts` never selects `token_hash` again. */
interface CreatedShareLink {
  readonly shareId: string
  readonly token: string
  readonly url: string
  readonly versionId?: string
}

interface ShareLinkSummary {
  readonly shareId: string
  readonly versionId: string
  readonly expiresAt: string | null
  readonly revokedAt: string | null
}

interface ShareLinkList {
  readonly items: readonly ShareLinkSummary[]
  readonly databaseNow?: string
}

export interface ShareCreateOptions {
  readonly host: string
  readonly id: string
  readonly versionId?: string
  readonly expires?: string
  readonly isJson: boolean
  readonly isInsecureAllowed?: boolean
}

export interface ShareListOptions {
  readonly host: string
  readonly id: string
  readonly isJson: boolean
  readonly isInsecureAllowed?: boolean
}

export interface ShareRevokeOptions {
  readonly host: string
  readonly shareId: string
  readonly isInsecureAllowed?: boolean
  /** Artifact whose share list resolves a `shareId` prefix. Accepts a prefix itself. */
  readonly artifactRef?: string
}

/**
 * A missing scope is a 403 (`requireApiPrincipal`), not the 401 the ticket predicted, so both
 * statuses name the scope — the user cannot act on "forbidden" without being told which one.
 * An ownership 403 reads as "not found", exactly like the 404 the `artifacts` commands print:
 * "belongs to another account" would confirm the artifact exists to someone who does not own it.
 */
function failureFor(host: string, isJson: boolean, given?: string): FailureContext {
  return {
    host,
    isJson,
    requiredScope: REQUIRED_SCOPE,
    isForbiddenNotFound: true,
    ...(given === undefined ? {} : { given }),
  }
}

/** Everything refused before a request is made, so nothing invalid ever reaches the network. */
function requireUuid(given: string, label: string): string {
  if (!UUID_PATTERN.test(given)) throw invalidArgument(`'${given}' is not a valid ${label}`)
  return given
}

/**
 * Second frame in the pre-send disclosure — local *date* and wall clock, not time alone.
 * West of UTC the local calendar day can differ from the UTC day in the first frame; omitting
 * the date made the disclosure unusable for the operators who need it most.
 */
function localClockLabel(when: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // `month: 'short'` (not 2-digit): next to a year-first UTC frame, day-first `10/08/2026` is
  // ambiguous for a US operator — `10 Aug 2026` matches `src/lib/format/instant.ts`.
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(when)
  return `${local} local, ${timeZone}`
}

/** Accepts `7d` / `12h` / `2w`, a local date, a local date-time, or a zoned instant. */
function parseExpiry(given: string, now: Date): Date {
  const trimmed = given.trim()
  const relative = RELATIVE_EXPIRY_PATTERN.exec(trimmed)

  let when: Date
  if (relative !== null) {
    const amount = Number(relative[1])
    const unit = (relative[2] ?? 'h').toLowerCase()
    const hours = amount * (HOURS_PER_UNIT[unit] ?? 1)
    const deltaMs = hours * MILLISECONDS_PER_HOUR
    if (!Number.isFinite(deltaMs) || Math.abs(now.getTime() + deltaMs) > MAX_DATE_MILLISECONDS) {
      throw invalidArgument(`--expires ${given} is out of range`)
    }
    when = new Date(now.getTime() + deltaMs)
  } else {
    when = parseAbsoluteExpiry(trimmed, given)
  }

  if (when.getTime() <= now.getTime()) {
    throw invalidArgument(
      `--expires ${given} resolves to ${when.toISOString()}, which is not in the future`,
    )
  }
  return when
}

/**
 * A date-only string has no wall-clock time of its own, so it resolves to the last instant of that
 * local day — the end of "the 10th" the operator meant, not local midnight at its start. A
 * zone-less date-time resolves as that exact wall clock in the same local zone. Both used to
 * silently disagree with a zoned instant (UTC midnight vs the operator's local midnight) even
 * though they look like the same kind of input — resolving both locally removes the ambiguity.
 */
function parseAbsoluteExpiry(trimmed: string, original: string): Date {
  const dateOnly = ISO_DATE_ONLY_PATTERN.exec(trimmed)
  if (dateOnly !== null) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const when = new Date(`${trimmed}T23:59:59.999`)
    // Reject calendar overflow (2027-02-30 → March) by requiring a round-trip.
    if (when.getFullYear() !== year || when.getMonth() !== month - 1 || when.getDate() !== day) {
      throw invalidArgument(`'${original}' must be ${EXPIRY_SHAPES}`)
    }
    return when
  }

  if (!ISO_ZONELESS_DATETIME_PATTERN.test(trimmed) && !ISO_ZONED_DATETIME_PATTERN.test(trimmed)) {
    throw invalidArgument(`'${original}' must be ${EXPIRY_SHAPES}`)
  }

  const when = new Date(trimmed)
  if (Number.isNaN(when.getTime())) {
    throw invalidArgument(`'${original}' must be ${EXPIRY_SHAPES}`)
  }
  return when
}

function createRequestBody(
  versionId: string | undefined,
  expiresAt: Date | null,
): Readonly<Record<string, string>> {
  const body: Record<string, string> = {}
  if (versionId !== undefined) body['versionId'] = versionId
  if (expiresAt !== null) body['expiresAt'] = expiresAt.toISOString()
  return body
}

function printCreated(
  ctx: CliContext,
  created: CreatedShareLink,
  versionId: string | undefined,
  expiresAt: Date | null,
  isJson: boolean,
): void {
  const expires = expiresAt === null ? null : expiresAt.toISOString()
  const resolvedVersionId = created.versionId ?? versionId

  if (isJson) {
    // The warning goes to stderr so stdout stays parseable.
    printDiagnostic(ctx, 'the share url is shown once and cannot be read again')
    printJson(ctx, {
      shareId: created.shareId,
      url: created.url,
      expiresAt: expires,
      ...(resolvedVersionId === undefined ? {} : { versionId: resolvedVersionId }),
    })
    return
  }

  printLine(ctx, 'Share link created.')
  printLine(ctx, 'This URL is shown once and can never be read again — copy it now.\n')
  printLine(ctx, `  ${created.url}\n`)
  printLine(ctx, `  share id  ${created.shareId}`)
  if (resolvedVersionId !== undefined) printLine(ctx, `  version   ${resolvedVersionId}`)
  printLine(ctx, `  expires   ${expires ?? NEVER}`)
}

export async function runShareCreate(
  options: ShareCreateOptions,
  ctx: CliContext,
): Promise<ExitCode> {
  try {
    const versionId =
      options.versionId === undefined ? undefined : requireUuid(options.versionId, 'version id')
    const expiresAt =
      options.expires === undefined ? null : parseExpiry(options.expires, new Date())

    // Both frames, so the operator can check the resolved instant against either clock they read —
    // stderr so `--json` stdout stays parseable.
    if (expiresAt !== null) {
      printDiagnostic(ctx, `expires ${expiresAt.toISOString()} (${localClockLabel(expiresAt)})`)
    }

    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const artifactId = await resolveArtifactId(client, options.id)
    const response = await client.post<CreatedShareLink>(
      `/api/v1/artifacts/${artifactId}/shares`,
      createRequestBody(versionId, expiresAt),
    )
    printCreated(ctx, response, versionId, expiresAt, options.isJson)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}

function stateOf(link: ShareLinkSummary, now: Date): 'revoked' | 'expired' | 'active' {
  if (link.revokedAt !== null) return 'revoked'
  if (link.expiresAt !== null && new Date(link.expiresAt).getTime() <= now.getTime()) {
    return 'expired'
  }
  return 'active'
}

/**
 * Projects four columns rather than echoing the response, so an unexpected field cannot leak.
 * STATE is judged on the server's clock (`databaseNow`), never the laptop's — the same rule the
 * API gate itself follows (src/lib/shares/clock.ts). Falls back to the laptop clock only against
 * an older server that has not yet started sending `databaseNow`.
 */
function printLinks(
  ctx: CliContext,
  items: readonly ShareLinkSummary[],
  databaseNow: string | undefined,
  isJson: boolean,
): void {
  const parsed = databaseNow === undefined ? Number.NaN : Date.parse(databaseNow)
  const now = Number.isNaN(parsed) ? new Date() : new Date(parsed)
  const rows = items.map((link) => ({
    shareId: link.shareId,
    versionId: link.versionId,
    expiresAt: link.expiresAt,
    state: stateOf(link, now),
  }))

  if (isJson) {
    printJson(ctx, rows)
    return
  }

  if (rows.length === 0) {
    printLine(ctx, 'no share links')
    return
  }

  printLine(
    ctx,
    `SHARE ID                              VERSION                               ${'EXPIRES'.padEnd(EXPIRES_COLUMN_WIDTH)}  STATE`,
  )
  for (const row of rows) {
    const expires = (row.expiresAt ?? NEVER).padEnd(EXPIRES_COLUMN_WIDTH)
    printLine(ctx, `${row.shareId}  ${row.versionId}  ${expires}  ${row.state}`)
  }
}

export async function runShareList(options: ShareListOptions, ctx: CliContext): Promise<ExitCode> {
  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const artifactId = await resolveArtifactId(client, options.id)
    const response = await client.get<ShareLinkList>(`/api/v1/artifacts/${artifactId}/shares`)
    printLinks(ctx, response.items, response.databaseNow, options.isJson)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}

/**
 * The artifact whose share list a prefix resolves against, or null for a full uuid that needs no
 * lookup. Share ids are not listable on their own, so a prefix without `--artifact` has nothing to
 * match — every refusal here is a malformed argument, made before any request.
 */
function prefixLookupArtifact(options: ShareRevokeOptions): string | null {
  if (UUID_PATTERN.test(options.shareId)) return null

  if (options.artifactRef === undefined) {
    if (SHARE_PREFIX_PATTERN.test(options.shareId)) {
      throw invalidArgument(
        'share ids are not resolvable by prefix — pass the full uuid, or:\n' +
          `enclave share revoke --artifact <artifact-id> ${options.shareId}`,
      )
    }
    throw invalidArgument(
      `'${options.shareId}' is not a valid share id — pass the full uuid that enclave share list <artifact-id> prints`,
    )
  }

  if (options.shareId.length < MIN_PREFIX_LENGTH) {
    throw invalidArgument(
      `'${options.shareId}' is too short — give at least ${String(MIN_PREFIX_LENGTH)} characters of the share id`,
    )
  }

  if (!SHARE_PREFIX_PATTERN.test(options.shareId)) {
    throw invalidArgument(
      `'${options.shareId}' is not a share-id prefix — share ids are hexadecimal, so give at least ${String(MIN_PREFIX_LENGTH)} hex characters`,
    )
  }
  return options.artifactRef
}

/** The single share link `prefix` names on the artifact, or null when it is already revoked. */
async function resolveSharePrefix(
  ctx: CliContext,
  client: ApiClient,
  artifactRef: string,
  prefix: string,
): Promise<string | null> {
  const artifactId = await resolveArtifactId(client, artifactRef)
  const response = await client.get<ShareLinkList>(`/api/v1/artifacts/${artifactId}/shares`)
  const lowered = prefix.toLowerCase()
  const matches = response.items.filter((link) => link.shareId.toLowerCase().startsWith(lowered))
  const [match] = matches

  if (match === undefined) {
    throw new CliError(
      'SHARE_NOT_RESOLVED',
      `no share link on ${shortId(artifactId)} starts with '${prefix}'`,
      { exitCode: EXIT_USAGE },
    )
  }

  if (matches.length > 1) {
    const listed = matches.map((link) => `  ${link.shareId}`).join('\n')
    throw new CliError(
      'SHARE_NOT_RESOLVED',
      `'${prefix}' matches ${String(matches.length)} share links on ${shortId(artifactId)}:\n${listed}`,
      { exitCode: EXIT_USAGE },
    )
  }

  if (match.revokedAt !== null) {
    printLine(ctx, `already revoked ${shortId(match.shareId)}`)
    return null
  }
  return match.shareId
}

export async function runShareRevoke(
  options: ShareRevokeOptions,
  ctx: CliContext,
): Promise<ExitCode> {
  try {
    const artifactRef = prefixLookupArtifact(options)
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const shareId =
      artifactRef === null
        ? options.shareId
        : await resolveSharePrefix(ctx, client, artifactRef, options.shareId)
    if (shareId === null) return EXIT_OK

    await client.remove(`/api/v1/shares/${shareId}`)
    printLine(ctx, `✓ revoked ${shortId(shareId)}`)
    return EXIT_OK
  } catch (error) {
    // `share revoke` takes no --json: it has no object to return.
    return reportFailure(error, ctx, failureFor(options.host, false))
  }
}
