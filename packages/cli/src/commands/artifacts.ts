import { ApiError, apiClient, type ApiClient } from '../api-client.ts'
import { tokenFor } from '../credentials.ts'
import { IdResolutionError, resolveArtifactId, shortId, type ArtifactSummary } from '../ids.ts'
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../exit-codes.ts'

const VISIBILITIES = ['private', 'org'] as const

export type Visibility = (typeof VISIBILITIES)[number]

const VISIBILITY_COLUMN_WIDTH = 7

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
}

export interface ShowOptions {
  readonly host: string
  readonly id: string
  readonly isJson: boolean
}

export interface RenameOptions {
  readonly host: string
  readonly id: string
  readonly title: string
  readonly isJson?: boolean
}

export interface PrivacyOptions {
  readonly host: string
  readonly id: string
  readonly visibility: string
  readonly isJson?: boolean
}

export interface RemoveOptions {
  readonly host: string
  readonly id: string
  readonly isJson?: boolean
}

export interface RestoreOptions {
  readonly host: string
  readonly id: string
  readonly isJson?: boolean
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

function requireClient(host: string): ApiClient {
  const token = tokenFor(host)
  if (token === null || token === '') {
    throw new CliError(`not logged in to ${host} — run: enclave login --host ${host}`)
  }
  return apiClient(host, token)
}

/**
 * A 404 is what the server returns for another user's artifact, deliberately. Printing "forbidden"
 * would confirm it exists, so every 404 reads the same as a typo.
 */
function reportFailure(error: unknown, given?: string): number {
  if (error instanceof ApiError && error.status === 404) {
    fail(given === undefined ? '✗ not found' : `✗ not found: ${given}`)
    return EXIT_FAILED
  }
  if (
    error instanceof ApiError ||
    error instanceof IdResolutionError ||
    error instanceof CliError
  ) {
    fail(`✗ ${error.message}`)
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

  for (;;) {
    const page = await client.get<ArtifactPage>(
      `/api/v1/artifacts${listQuery(options.limit, cursor)}`,
    )
    items.push(...page.items)
    if (isPageRequest) return { items, nextCursor: page.nextCursor }
    if (page.nextCursor === null) return { items, nextCursor: null }
    cursor = page.nextCursor
  }
}

function printArtifacts(page: ArtifactPage): void {
  if (page.items.length === 0) {
    write('no artifacts')
    return
  }

  const titleWidth = Math.max(...page.items.map((item) => item.title.length))
  for (const item of page.items) {
    const title = item.title.padEnd(titleWidth)
    const visibility = item.visibility.padEnd(VISIBILITY_COLUMN_WIDTH)
    write(`${shortId(item.id)}  ${title}  ${visibility}  ${item.viewUrl}`)
  }

  if (page.nextCursor !== null) write(`\nmore: enclave list --cursor ${page.nextCursor}`)
}

function printArtifact(artifact: ArtifactView): void {
  write(`id          ${artifact.id}`)
  write(`title       ${artifact.title}`)
  write(`visibility  ${artifact.visibility}`)
  write(`created     ${artifact.createdAt}`)
  write(`url         ${artifact.viewUrl}`)
}

export async function runList(options: ListOptions): Promise<number> {
  try {
    const client = requireClient(options.host)
    const page = await readArtifacts(client, options)

    if (options.isJson) writeJson(page)
    else printArtifacts(page)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error)
  }
}

export async function runShow(options: ShowOptions): Promise<number> {
  try {
    const client = requireClient(options.host)
    const id = await resolveArtifactId(client, options.id)
    const artifact = await client.get<ArtifactView>(`/api/v1/artifacts/${id}`)

    if (options.isJson) writeJson(artifact)
    else printArtifact(artifact)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.id)
  }
}

export async function runRename(options: RenameOptions): Promise<number> {
  const title = options.title.trim()
  if (title === '') {
    write('✗ a title is required')
    return EXIT_USAGE
  }

  try {
    const client = requireClient(options.host)
    const id = await resolveArtifactId(client, options.id)
    // `{title}` alone. PATCH is the only writer of `artifact.visibility_change`, so echoing
    // visibility back would log a privacy change for a rename.
    const artifact = await client.patch<ArtifactView>(`/api/v1/artifacts/${id}`, { title })

    if (options.isJson === true) writeJson(artifact)
    else write(`✓ ${shortId(artifact.id)} renamed to "${artifact.title}"`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.id)
  }
}

export async function runPrivacy(options: PrivacyOptions): Promise<number> {
  // Refused before the id is resolved: resolving a prefix costs a request, and there is nothing to
  // send — VISIBILITIES is ['private','org'] and the third privacy level is a share link.
  if (!isVisibility(options.visibility)) {
    write(`✗ visibility must be private or org, not '${options.visibility}'`)
    if (options.visibility === 'public') {
      write('  a share link is how you publish beyond this instance')
    }
    return EXIT_USAGE
  }

  try {
    const client = requireClient(options.host)
    const id = await resolveArtifactId(client, options.id)
    const before = await client.get<ArtifactView>(`/api/v1/artifacts/${id}`)
    const after = await client.patch<ArtifactView>(`/api/v1/artifacts/${id}`, {
      visibility: options.visibility,
    })

    if (options.isJson === true) writeJson(after)
    else printPrivacyChange(before, after)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.id)
  }
}

function printPrivacyChange(before: ArtifactView, after: ArtifactView): void {
  write(`  ${shortId(after.id)}  ${after.title}`)
  write(`  ${before.visibility} → ${after.visibility}`)
  write(
    after.visibility === 'org'
      ? '  ✓ everyone on this instance can now read it'
      : '  ✓ only you can read it now',
  )
}

export async function runRemove(options: RemoveOptions): Promise<number> {
  try {
    const client = requireClient(options.host)
    const id = await resolveArtifactId(client, options.id)
    await client.remove(`/api/v1/artifacts/${id}`)

    if (options.isJson === true) {
      writeJson({ id, deleted: true })
      return EXIT_OK
    }
    write(`✓ moved ${shortId(id)} to trash`)
    // The full id, not the prefix: a trashed artifact leaves GET /v1/artifacts, so a prefix has
    // nothing left to resolve against until S21 adds trash listing.
    write(`  restore with: enclave restore ${id}`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.id)
  }
}

export async function runRestore(options: RestoreOptions): Promise<number> {
  try {
    const client = requireClient(options.host)
    const id = await resolveArtifactId(client, options.id)
    const artifact = await client.post<ArtifactView>(
      `/api/v1/artifacts/${id}/restore`,
      // No body: the route reads none, and sending one would add a content-type it never asked for.
      undefined,
    )

    if (options.isJson === true) writeJson(artifact)
    else write(`✓ restored ${shortId(artifact.id)}  ${artifact.title}`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, options.id)
  }
}
