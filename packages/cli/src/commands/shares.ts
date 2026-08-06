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

/** Everything refused before a request is made, so nothing invalid ever reaches the network. */
class InvalidInputError extends Error {}

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

function clientFor(host: string, isInsecureAllowed = false): ApiClient | null {
  const token = tokenFor(host)
  // An empty stored token is not a credential. Sending `Authorization: Bearer ` puts it on the
  // wire and surfaces the server's scope error instead of the local one the user can act on.
  if (token === null || token === '') {
    fail(`not logged in to ${host} — run: enclave login --host ${host}`)
    return null
  }
  return apiClient(host, token, isInsecureAllowed)
}

function requireUuid(given: string, label: string): string {
  if (!UUID_PATTERN.test(given)) throw new InvalidInputError(`'${given}' is not a valid ${label}`)
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
      throw new InvalidInputError(`--expires ${given} is out of range`)
    }
    when = new Date(now.getTime() + deltaMs)
  } else {
    when = parseAbsoluteExpiry(trimmed, given)
  }

  if (when.getTime() <= now.getTime()) {
    throw new InvalidInputError(
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
      throw new InvalidInputError(`'${original}' must be ${EXPIRY_SHAPES}`)
    }
    return when
  }

  if (!ISO_ZONELESS_DATETIME_PATTERN.test(trimmed) && !ISO_ZONED_DATETIME_PATTERN.test(trimmed)) {
    throw new InvalidInputError(`'${original}' must be ${EXPIRY_SHAPES}`)
  }

  const when = new Date(trimmed)
  if (Number.isNaN(when.getTime())) {
    throw new InvalidInputError(`'${original}' must be ${EXPIRY_SHAPES}`)
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
  created: CreatedShareLink,
  versionId: string | undefined,
  expiresAt: Date | null,
  isJson: boolean,
): void {
  const expires = expiresAt === null ? null : expiresAt.toISOString()
  const resolvedVersionId = created.versionId ?? versionId

  if (isJson) {
    // The warning goes to stderr so stdout stays parseable.
    fail('the share url is shown once and cannot be read again')
    process.stdout.write(
      `${JSON.stringify({
        shareId: created.shareId,
        url: created.url,
        expiresAt: expires,
        ...(resolvedVersionId === undefined ? {} : { versionId: resolvedVersionId }),
      })}\n`,
    )
    return
  }

  process.stdout.write('Share link created.\n')
  process.stdout.write('This URL is shown once and can never be read again — copy it now.\n\n')
  process.stdout.write(`  ${created.url}\n\n`)
  process.stdout.write(`  share id  ${created.shareId}\n`)
  if (resolvedVersionId !== undefined) {
    process.stdout.write(`  version   ${resolvedVersionId}\n`)
  }
  process.stdout.write(`  expires   ${expires ?? NEVER}\n`)
}

export async function runShareCreate(options: ShareCreateOptions): Promise<number> {
  let versionId: string | undefined
  let expiresAt: Date | null

  try {
    versionId =
      options.versionId === undefined ? undefined : requireUuid(options.versionId, 'version id')
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

  const client = clientFor(options.host, options.isInsecureAllowed)
  if (client === null) return EXIT_FAILED

  try {
    const artifactId = await resolveArtifactId(client, options.id)
    const response = await client.post<CreatedShareLink>(
      `/api/v1/artifacts/${artifactId}/shares`,
      createRequestBody(versionId, expiresAt),
    )
    printCreated(response, versionId, expiresAt, options.isJson)
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

  process.stdout.write(`SHARE ID                              VERSION                               ${'EXPIRES'.padEnd(EXPIRES_COLUMN_WIDTH)}  STATE\n`)
  for (const row of rows) {
    const expires = (row.expiresAt ?? NEVER).padEnd(EXPIRES_COLUMN_WIDTH)
    process.stdout.write(
      `${row.shareId}  ${row.versionId}  ${expires}  ${row.state}\n`,
    )
  }
}

export async function runShareList(options: ShareListOptions): Promise<number> {
  const client = clientFor(options.host, options.isInsecureAllowed)
  if (client === null) return EXIT_FAILED

  try {
    const artifactId = await resolveArtifactId(client, options.id)
    const response = await client.get<ShareLinkList>(`/api/v1/artifacts/${artifactId}/shares`)
    printLinks(response.items, response.databaseNow, options.isJson)
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

  const client = clientFor(options.host, options.isInsecureAllowed)
  if (client === null) return EXIT_FAILED

  try {
    await client.remove(`/api/v1/shares/${shareId}`)
    process.stdout.write(`✓ revoked ${shortId(shareId)}\n`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error)
  }
}
