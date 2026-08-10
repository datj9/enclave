import { ApiError, apiClient, type ApiClient } from '../api-client.ts'
import { tokenFor } from '../credentials.ts'
import { displayTitle } from '../display.ts'
import {
  IdResolutionError,
  InvalidIdError,
  MIN_PREFIX_LENGTH,
  resolveArtifactId,
  shortId,
  type ArtifactSummary,
} from '../ids.ts'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../exit-codes.ts'

const VISIBILITIES = ['private', 'org', 'public'] as const

export type Visibility = (typeof VISIBILITIES)[number]

const TITLE_HEADER = 'TITLE'
/** Caps the row at 8 + 2 + 40 + 2 + 10 columns, so `list` fits an 80-column terminal. */
const MAX_TITLE_WIDTH = 40
/** ASCII: nothing in this package establishes that the terminal can render a wider glyph. */
const ELLIPSIS = '...'
const MAX_PAGES = 100

export interface ArtifactView {
  readonly id: string
  readonly title: string
  readonly slug: string
  readonly visibility: Visibility
  readonly createdAt: string
  readonly updatedAt: string
  readonly viewUrl: string
}

export interface ArtifactPage {
  readonly items: readonly ArtifactSummary[]
  readonly nextCursor: string | null
}

export interface ListOptions {
  readonly host: string
  readonly limit?: number
  readonly cursor?: string
  readonly isJson: boolean
  readonly isInsecureAllowed?: boolean
}

export interface ShowOptions {
  readonly host: string
  readonly id: string
  readonly isJson: boolean
  readonly isInsecureAllowed?: boolean
}

export interface RenameOptions {
  readonly host: string
  readonly id: string
  readonly title: string
  readonly isJson?: boolean
  readonly isInsecureAllowed?: boolean
}

export interface PrivacyOptions {
  readonly host: string
  readonly id: string
  readonly visibility: string
  readonly isJson?: boolean
  readonly isInsecureAllowed?: boolean
}

export interface RemoveOptions {
  readonly host: string
  readonly id: string
  readonly isJson?: boolean
  readonly isInsecureAllowed?: boolean
}

export interface RestoreOptions {
  readonly host: string
  readonly id: string
  readonly isJson?: boolean
  readonly isInsecureAllowed?: boolean
}

class CliError extends Error {}

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Failures go to stderr, never stdout. `--json` promises stdout carries the API object and nothing
 * else, so a human-readable error printed there turns `enclave show … --json | jq` into a parse
 * error instead of a diagnosable failure.
 */
function fail(line: string): void {
  process.stderr.write(`${line}\n`)
}

function requireClient(host: string, isInsecureAllowed = false): ApiClient {
  const token = tokenFor(host)
  if (token === null || token === '') {
    throw new CliError(`not logged in to ${host} — run: enclave login --host ${host}`)
  }
  return apiClient(host, token, isInsecureAllowed)
}

/** `main` hands over a normalised `https://host`; a caller that resolved its own passes a bare
 *  name. Both spellings have to reach a URL. */
function originOf(host: string): string {
  return host.includes('://') ? host : `https://${host}`
}

function artifactPageUrl(host: string, id: string): string {
  return `${originOf(host)}/a/${id}`
}

/**
 * A 404 is what the server returns for another user's artifact, deliberately. Printing "forbidden"
 * would confirm it exists, so every 404 reads the same as a typo.
 */
function reportFailure(error: unknown, host: string, given?: string): number {
  if (error instanceof ApiError && error.status === 404) {
    fail(given === undefined ? '✗ not found' : `✗ not found: ${given}`)
    return EXIT_FAILED
  }
  // A prefix too short to resolve is a malformed argument, not a lookup that came back empty —
  // callers distinguish those by exit code, so it exits 2 like every other unusable value.
  if (error instanceof InvalidIdError) {
    fail(`✗ ${error.message}`)
    return EXIT_USAGE
  }
  if (error instanceof ApiError && error.status === 401) {
    fail('✗ the API token was rejected — it may be expired, revoked, or minted for another host')
    fail(`  log in again: enclave login --host ${host}`)
    return EXIT_FAILED
  }
  // Kept off the 401 branch on purpose: a token that authenticated but lacks a scope is refused
  // with 403, and logging in again with that same token changes nothing.
  if (
    error instanceof ApiError &&
    error.status === 403 &&
    error.message.toLowerCase().includes('scope')
  ) {
    fail(`✗ ${error.message}`)
    fail(`  mint a token with that scope at ${originOf(host)}/settings/tokens,`)
    fail(`  then: enclave login --host ${host}`)
    return EXIT_FAILED
  }
  if (
    error instanceof ApiError ||
    error instanceof IdResolutionError ||
    error instanceof CliError
  ) {
    fail(`✗ ${error.message}`)
    if (error instanceof ApiError && Object.keys(error.details).length > 0) {
      const rendered = Object.entries(error.details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
      fail(`  ${rendered}`)
    }
    return EXIT_FAILED
  }
  fail(`✗ ${error instanceof Error ? error.message : String(error)}`)
  return EXIT_FAILED
}

function isVisibility(value: string): value is Visibility {
  return (VISIBILITIES as readonly string[]).includes(value)
}

function listQuery(limit: number | undefined, cursor: string | null): string {
  const parts: string[] = []
  if (limit !== undefined) parts.push(`limit=${String(limit)}`)
  if (cursor !== null) parts.push(`cursor=${encodeURIComponent(cursor)}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

/**
 * With no `--limit` or `--cursor` every page is walked. Fetching page one and dropping
 * `nextCursor` is the dashboard's bug (`app/dashboard/page.tsx:45`) and is not repeated here.
 */
async function readArtifacts(client: ApiClient, options: ListOptions): Promise<ArtifactPage> {
  const isPageRequest = options.limit !== undefined || options.cursor !== undefined
  const items: ArtifactSummary[] = []
  let cursor: string | null = options.cursor ?? null
  const seenCursors = new Set<string>()
  let pages = 0

  for (;;) {
    const page = await client.get<ArtifactPage>(
      `/api/v1/artifacts${listQuery(options.limit, cursor)}`,
    )
    items.push(...page.items)
    if (isPageRequest) return { items, nextCursor: page.nextCursor }
    pages += 1
    if (page.nextCursor === null || page.nextCursor === undefined) return { items, nextCursor: null }
    if (seenCursors.has(page.nextCursor)) {
      throw new CliError('the server returned a cursor it had already given — stopping')
    }
    if (pages >= MAX_PAGES) {
      throw new CliError(
        `stopped after ${String(MAX_PAGES)} pages — pass --limit and --cursor to page through more`,
      )
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

function fitTitle(title: string): string {
  if (title.length <= MAX_TITLE_WIDTH) return title
  return `${title.slice(0, MAX_TITLE_WIDTH - ELLIPSIS.length)}${ELLIPSIS}`
}

/**
 * Four unlabelled columns wrapping mid-URL is what this replaces. `viewUrl` is derivable from the
 * id and 60 columns wide, so human mode drops it — `show` prints it, `--json` still carries it.
 * Visibility goes last unpadded: padding the final column emits trailing whitespace on every row.
 */
function printArtifacts(page: ArtifactPage): void {
  if (page.items.length === 0) {
    write('no artifacts')
    return
  }

  const titles = page.items.map((item) => fitTitle(displayTitle(item.title)))
  const titleWidth = titles.reduce(
    (widest, title) => Math.max(widest, title.length),
    TITLE_HEADER.length,
  )

  write(`${'ID'.padEnd(MIN_PREFIX_LENGTH)}  ${TITLE_HEADER.padEnd(titleWidth)}  VISIBILITY`)
  page.items.forEach((item, index) => {
    const title = (titles[index] ?? '').padEnd(titleWidth)
    write(`${shortId(item.id)}  ${title}  ${item.visibility}`)
  })

  if (page.nextCursor !== null) write(`\nmore: enclave list --cursor ${page.nextCursor}`)
}

/**
 * `url` is the `/a/{id}` page. The artifact origin 404s without the grant cookie `/enter` mints,
 * so it is labelled as provenance rather than printed as somewhere to send anyone.
 */
function printArtifact(host: string, artifact: ArtifactView): void {
  write(`id          ${artifact.id}`)
  write(`title       ${displayTitle(artifact.title)}`)
  write(`visibility  ${artifact.visibility}`)
  write(`created     ${artifact.createdAt}`)
  write(`url         ${artifactPageUrl(host, artifact.id)}`)
  write(`served from ${artifact.viewUrl}`)
}

export async function runList(options: ListOptions): Promise<number> {
  try {
    const client = requireClient(options.host, options.isInsecureAllowed)
    const page = await readArtifacts(client, options)

    if (options.isJson) writeJson(page)
    else printArtifacts(page)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.host)
  }
}

export async function runShow(options: ShowOptions): Promise<number> {
  try {
    const client = requireClient(options.host, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    const artifact = await client.get<ArtifactView>(`/api/v1/artifacts/${id}`)

    if (options.isJson) writeJson(artifact)
    else printArtifact(options.host, artifact)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.host, options.id)
  }
}

export async function runRename(options: RenameOptions): Promise<number> {
  const title = options.title.trim()
  if (title === '') {
    fail('✗ a title is required')
    return EXIT_USAGE
  }

  try {
    const client = requireClient(options.host, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    // `{title}` alone. PATCH is the only writer of `artifact.visibility_change`, so echoing
    // visibility back would log a privacy change for a rename.
    const artifact = await client.patch<ArtifactView>(`/api/v1/artifacts/${id}`, { title })

    if (options.isJson === true) writeJson(artifact)
    else write(`✓ ${shortId(artifact.id)} renamed to "${displayTitle(artifact.title)}"`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.host, options.id)
  }
}

export async function runPrivacy(options: PrivacyOptions): Promise<number> {
  // Refused before the id is resolved: resolving a prefix costs a request, and there is nothing to
  // send. `enclave share create` is the fourth level; it is a capability, not a visibility value.
  if (!isVisibility(options.visibility)) {
    fail(`✗ visibility must be private, org, or public, not '${options.visibility}'`)
    fail('  to publish one pinned version behind a revocable link, use `enclave share create`')
    return EXIT_USAGE
  }

  try {
    const client = requireClient(options.host, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    const before = await client.get<ArtifactView>(`/api/v1/artifacts/${id}`)
    const after = await client.patch<ArtifactView>(`/api/v1/artifacts/${id}`, {
      visibility: options.visibility,
    })

    if (options.isJson === true) writeJson(after)
    else printPrivacyChange(before, after)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.host, options.id)
  }
}

const PRIVACY_OUTCOME: Record<Visibility, string> = {
  private: '  ✓ only you can read it now',
  org: '  ✓ everyone on this instance can now read it',
  public: '  ✓ anyone with the address can now read it, and search engines may index it',
}

function printPrivacyChange(before: ArtifactView, after: ArtifactView): void {
  write(`  ${shortId(after.id)}  ${displayTitle(after.title)}`)
  write(`  ${before.visibility} → ${after.visibility}`)
  write(PRIVACY_OUTCOME[after.visibility])
}

export async function runRemove(options: RemoveOptions): Promise<number> {
  try {
    const client = requireClient(options.host, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    await client.remove(`/api/v1/artifacts/${id}`)

    if (options.isJson === true) {
      writeJson({ id, deleted: true })
      return EXIT_OK
    }
    write(`✓ moved ${shortId(id)} to trash`)
    // The full id, not the prefix: a trashed artifact leaves GET /v1/artifacts, so a prefix has
    // nothing left to resolve against.
    write(`  restore with: enclave restore ${id}`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.host, options.id)
  }
}

export async function runRestore(options: RestoreOptions): Promise<number> {
  try {
    const client = requireClient(options.host, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    const artifact = await client.post<ArtifactView>(
      `/api/v1/artifacts/${id}/restore`,
      // No body: the route reads none, and sending one would add a content-type it never asked for.
      undefined,
    )

    if (options.isJson === true) writeJson(artifact)
    else write(`✓ restored ${shortId(artifact.id)}  ${displayTitle(artifact.title)}`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.host, options.id)
  }
}
