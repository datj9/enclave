import { ApiError, apiClient, type ApiClient } from '../api-client.ts'
import { tokenFor } from '../credentials.ts'
import { IdResolutionError, resolveArtifactId, shortId } from '../ids.ts'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../exit-codes.ts'

/**
 * `enclave share create|list|revoke` (S20). A share URL is a bearer capability: it is printed to
 * stdout and nowhere else — never written to the state file, never attached to an error, never
 * echoed back by `list`, which projects its own columns rather than dumping the response.
 */

const REQUIRED_SCOPE = 'shares:write'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RELATIVE_EXPIRY_PATTERN = /^(\d+)([hdw])$/i
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ZONELESS_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/
const ZONED_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
const HOURS_PER_UNIT: Readonly<Record<string, number>> = { h: 1, d: 24, w: 168 }
const MILLISECONDS_PER_HOUR = 3_600_000

/**
 * A bare date and a zone-less date-time used to resolve to different frames (UTC midnight vs the
 * operator's local midnight) even though they look like the same kind of input. Both now resolve
 * in the operator's local zone so the same typed shape never silently means two different instants.
 */
const EXPIRY_SHAPES =
  'a duration like 7d, 12h or 2w, a date like 2026-08-10, a date-time like 2026-08-10T14:30, ' +
  'or an ISO-8601 instant with an explicit zone such as 2026-08-10T23:59:00+07:00 or ' +
  '2026-08-10T16:59:00Z'

const EXPIRES_COLUMN_WIDTH = 24
const NEVER = 'never'

/** Every route wraps its payload (`jsonData` in `src/lib/http.ts`); the client returns it verbatim. */
interface DataEnvelope<TData> {
  readonly data: TData
}

/** `token` is readable exactly once — `src/lib/shares/manage.ts` never selects `token_hash` again. */
interface CreatedShareLink {
  readonly shareId: string
  readonly token: string
  readonly url: string
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

/** Everything refused before a request is made, so nothing invalid ever reaches the network. */
class InvalidInputError extends Error {}

export interface ShareCreateOptions {
  readonly host: string
  readonly id: string
  readonly versionId?: string
  readonly expires?: string
  readonly isJson: boolean
}

export interface ShareListOptions {
  readonly host: string
  readonly id: string
  readonly isJson: boolean
}

export interface ShareRevokeOptions {
  readonly host: string
  readonly shareId: string
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * A missing scope is a 403 (`requireApiPrincipal`), not the 401 the ticket predicted, so both
 * statuses name the scope — the user cannot act on "forbidden" without being told which one.
 * A 404 stays "not found": saying more would confirm an artifact exists to someone who cannot read it.
 */
function describeApiError(error: ApiError): string {
  if (error.status === 401) {
    return `not authenticated — this command needs an API token with scope ${REQUIRED_SCOPE}`
  }
  if (error.status === 403 && error.message.toLowerCase().includes('scope')) {
    return `your token is missing scope ${REQUIRED_SCOPE} — mint a new token that has it`
  }
  if (error.status === 403) return 'that artifact belongs to another account'
  if (error.status === 404) return 'not found'
  return error.message
}

function reportFailure(error: unknown): number {
  if (error instanceof ApiError) {
    fail(describeApiError(error))
    return EXIT_FAILED
  }
  if (error instanceof IdResolutionError) {
    fail(error.message)
    return EXIT_FAILED
  }
  throw error
}

function clientFor(host: string): ApiClient | null {
  const token = tokenFor(host)
  if (token === null) {
    fail(`not logged in to ${host} — run: enclave login --host ${host}`)
    return null
  }
  return apiClient(host, token)
}

function requireUuid(given: string, label: string): string {
  if (!UUID_PATTERN.test(given)) throw new InvalidInputError(`'${given}' is not a valid ${label}`)
  return given
}

/**
 * A date-only string has no wall-clock time of its own, so it is read as the last instant of that
 * local day rather than local midnight — the end of "the 10th" the operator meant, not its start.
 */
function resolveAbsoluteExpiry(trimmed: string): Date {
  if (DATE_ONLY_PATTERN.test(trimmed)) return new Date(`${trimmed}T23:59:59.999`)
  if (ZONELESS_DATETIME_PATTERN.test(trimmed) || ZONED_DATETIME_PATTERN.test(trimmed)) {
    return new Date(trimmed)
  }
  return new Date(Number.NaN)
}

/** `23:59:59 local, Asia/Jakarta` — the second frame in the pre-send disclosure below. */
function localClockLabel(when: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(when)
  return `${localTime} local, ${timeZone}`
}

/** Accepts `7d` / `12h` / `2w`, a local date, a local date-time, or a zoned instant. */
function parseExpiry(given: string, now: Date): Date {
  const trimmed = given.trim()
  const relative = RELATIVE_EXPIRY_PATTERN.exec(trimmed)

  const when =
    relative === null
      ? resolveAbsoluteExpiry(trimmed)
      : new Date(
          now.getTime() +
            Number(relative[1]) *
              (HOURS_PER_UNIT[(relative[2] ?? 'h').toLowerCase()] ?? 1) *
              MILLISECONDS_PER_HOUR,
        )

  if (Number.isNaN(when.getTime())) {
    throw new InvalidInputError(`'${given}' must be ${EXPIRY_SHAPES}`)
  }
  if (when.getTime() <= now.getTime()) {
    throw new InvalidInputError(
      `--expires ${given} resolves to ${when.toISOString()}, which is not in the future`,
    )
  }
  return when
}

function createRequestBody(
  versionId: string,
  expiresAt: Date | null,
): Readonly<Record<string, string>> {
  return expiresAt === null ? { versionId } : { versionId, expiresAt: expiresAt.toISOString() }
}

function printCreated(
  created: CreatedShareLink,
  versionId: string,
  expiresAt: Date | null,
  isJson: boolean,
): void {
  const expires = expiresAt === null ? null : expiresAt.toISOString()

  if (isJson) {
    // The warning goes to stderr so stdout stays parseable.
    fail('the share url is shown once and cannot be read again')
    process.stdout.write(
      `${JSON.stringify({ shareId: created.shareId, url: created.url, expiresAt: expires })}\n`,
    )
    return
  }

  process.stdout.write('Share link created.\n')
  process.stdout.write('This URL is shown once and can never be read again — copy it now.\n\n')
  process.stdout.write(`  ${created.url}\n\n`)
  process.stdout.write(`  share id  ${created.shareId}\n`)
  process.stdout.write(`  version   ${shortId(versionId)}\n`)
  process.stdout.write(`  expires   ${expires ?? NEVER}\n`)
}

export async function runShareCreate(options: ShareCreateOptions): Promise<number> {
  let versionId: string
  let expiresAt: Date | null

  try {
    if (options.versionId === undefined) {
      // The route requires `versionId` and no bearer-reachable endpoint lists versions yet (S16),
      // so there is nothing to default to.
      throw new InvalidInputError('--version <versionId> is required')
    }
    versionId = requireUuid(options.versionId, 'version id')
    expiresAt = options.expires === undefined ? null : parseExpiry(options.expires, new Date())
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error
    fail(error.message)
    return EXIT_USAGE
  }

  // Both frames, so the operator can check the resolved instant against either clock they read —
  // stderr so `--json` stdout stays parseable.
  if (expiresAt !== null) {
    process.stderr.write(`expires ${expiresAt.toISOString()} (${localClockLabel(expiresAt)})\n`)
  }

  const client = clientFor(options.host)
  if (client === null) return EXIT_FAILED

  try {
    const artifactId = await resolveArtifactId(client, options.id)
    const response = await client.post<DataEnvelope<CreatedShareLink>>(
      `/api/v1/artifacts/${artifactId}/shares`,
      createRequestBody(versionId, expiresAt),
    )
    printCreated(response.data, versionId, expiresAt, options.isJson)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error)
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
    process.stdout.write(`${JSON.stringify(rows)}\n`)
    return
  }

  if (rows.length === 0) {
    process.stdout.write('no share links\n')
    return
  }

  process.stdout.write(`SHARE ID  VERSION   ${'EXPIRES'.padEnd(EXPIRES_COLUMN_WIDTH)}  STATE\n`)
  for (const row of rows) {
    const expires = (row.expiresAt ?? NEVER).padEnd(EXPIRES_COLUMN_WIDTH)
    process.stdout.write(
      `${shortId(row.shareId)}  ${shortId(row.versionId)}  ${expires}  ${row.state}\n`,
    )
  }
}

export async function runShareList(options: ShareListOptions): Promise<number> {
  const client = clientFor(options.host)
  if (client === null) return EXIT_FAILED

  try {
    const artifactId = await resolveArtifactId(client, options.id)
    const response = await client.get<DataEnvelope<ShareLinkList>>(
      `/api/v1/artifacts/${artifactId}/shares`,
    )
    printLinks(response.data.items, response.data.databaseNow, options.isJson)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error)
  }
}

export async function runShareRevoke(options: ShareRevokeOptions): Promise<number> {
  let shareId: string
  try {
    shareId = requireUuid(options.shareId, 'share id')
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error
    fail(error.message)
    return EXIT_USAGE
  }

  const client = clientFor(options.host)
  if (client === null) return EXIT_FAILED

  try {
    await client.remove(`/api/v1/shares/${shareId}`)
    process.stdout.write(`✓ revoked ${shortId(shareId)}\n`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error)
  }
}
