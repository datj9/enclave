import type { ApiClient } from '../api-client.ts'
import { requireClient } from '../auth.ts'
import { displayTitle } from '../display.ts'
import {
  CliError,
  invalidArgument,
  originOf,
  reportFailure,
  type FailureContext,
} from '../errors.ts'
import { EXIT_OK, type ExitCode } from '../exit-codes.ts'
import { MIN_PREFIX_LENGTH, resolveArtifactId, shortId, type ArtifactSummary } from '../ids.ts'
import { printJson, printLine, type CliContext } from '../output.ts'

const VISIBILITIES = ['private', 'org', 'public'] as const

export type Visibility = (typeof VISIBILITIES)[number]

const TITLE_HEADER = 'TITLE'
/** Caps the row at 8 + 2 + 40 + 2 + 10 columns, so `list` fits an 80-column terminal. */
const MAX_TITLE_WIDTH = 40
/** ASCII: nothing in this package establishes that the terminal can render a wider glyph. */
const ELLIPSIS = '...'
const MAX_PAGES = 100
/** Pretty-printed since the first release; a script may be reading it line by line. */
const JSON_INDENT = 2

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

/** Every artifacts command resolves a canonical host and may be reporting against it. */
function failureFor(host: string, isJson: boolean | undefined, given?: string): FailureContext {
  return { host, isJson: isJson === true, ...(given === undefined ? {} : { given }) }
}

function artifactPageUrl(host: string, id: string): string {
  return `${originOf(host)}/a/${id}`
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
    if (page.nextCursor === null || page.nextCursor === undefined)
      return { items, nextCursor: null }
    if (seenCursors.has(page.nextCursor)) {
      throw new CliError(
        'PAGINATION_LOOP',
        'the server returned a cursor it had already given — stopping',
      )
    }
    if (pages >= MAX_PAGES) {
      throw new CliError(
        'TOO_MANY_PAGES',
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
function printArtifacts(ctx: CliContext, page: ArtifactPage): void {
  if (page.items.length === 0) {
    printLine(ctx, 'no artifacts')
    return
  }

  const titles = page.items.map((item) => fitTitle(displayTitle(item.title)))
  const titleWidth = titles.reduce(
    (widest, title) => Math.max(widest, title.length),
    TITLE_HEADER.length,
  )

  printLine(
    ctx,
    `${'ID'.padEnd(MIN_PREFIX_LENGTH)}  ${TITLE_HEADER.padEnd(titleWidth)}  VISIBILITY`,
  )
  page.items.forEach((item, index) => {
    const title = (titles[index] ?? '').padEnd(titleWidth)
    printLine(ctx, `${shortId(item.id)}  ${title}  ${item.visibility}`)
  })

  if (page.nextCursor !== null) printLine(ctx, `\nmore: enclave list --cursor ${page.nextCursor}`)
}

/**
 * `url` is the `/a/{id}` page. The artifact origin 404s without the grant cookie `/enter` mints,
 * so it is labelled as provenance rather than printed as somewhere to send anyone.
 */
function printArtifact(ctx: CliContext, host: string, artifact: ArtifactView): void {
  printLine(ctx, `id          ${artifact.id}`)
  printLine(ctx, `title       ${displayTitle(artifact.title)}`)
  printLine(ctx, `visibility  ${artifact.visibility}`)
  printLine(ctx, `created     ${artifact.createdAt}`)
  printLine(ctx, `url         ${artifactPageUrl(host, artifact.id)}`)
  printLine(ctx, `served from ${artifact.viewUrl}`)
}

export async function runList(options: ListOptions, ctx: CliContext): Promise<ExitCode> {
  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const page = await readArtifacts(client, options)

    if (options.isJson) printJson(ctx, page, JSON_INDENT)
    else printArtifacts(ctx, page)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson))
  }
}

export async function runShow(options: ShowOptions, ctx: CliContext): Promise<ExitCode> {
  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    const artifact = await client.get<ArtifactView>(`/api/v1/artifacts/${id}`)

    if (options.isJson) printJson(ctx, artifact, JSON_INDENT)
    else printArtifact(ctx, options.host, artifact)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}

export async function runRename(options: RenameOptions, ctx: CliContext): Promise<ExitCode> {
  const title = options.title.trim()
  if (title === '') {
    return reportFailure(
      invalidArgument('a title is required'),
      ctx,
      failureFor(options.host, options.isJson),
    )
  }

  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    // `{title}` alone. PATCH is the only writer of `artifact.visibility_change`, so echoing
    // visibility back would log a privacy change for a rename.
    const artifact = await client.patch<ArtifactView>(`/api/v1/artifacts/${id}`, { title })

    if (options.isJson === true) printJson(ctx, artifact, JSON_INDENT)
    else printLine(ctx, `✓ ${shortId(artifact.id)} renamed to "${displayTitle(artifact.title)}"`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}

export async function runPrivacy(options: PrivacyOptions, ctx: CliContext): Promise<ExitCode> {
  // Refused before the id is resolved: resolving a prefix costs a request, and there is nothing to
  // send. `enclave share create` is the fourth level; it is a capability, not a visibility value.
  if (!isVisibility(options.visibility)) {
    const refusal = invalidArgument(
      `visibility must be private, org, or public, not '${options.visibility}'`,
      ['to publish one pinned version behind a revocable link, use `enclave share create`'],
    )
    return reportFailure(refusal, ctx, failureFor(options.host, options.isJson))
  }

  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    const before = await client.get<ArtifactView>(`/api/v1/artifacts/${id}`)
    const after = await client.patch<ArtifactView>(`/api/v1/artifacts/${id}`, {
      visibility: options.visibility,
    })

    if (options.isJson === true) printJson(ctx, after, JSON_INDENT)
    else printPrivacyChange(ctx, before, after)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}

const PRIVACY_OUTCOME: Record<Visibility, string> = {
  private: '  ✓ only you can read it now',
  org: '  ✓ everyone on this instance can now read it',
  public: '  ✓ anyone with the address can now read it, and search engines may index it',
}

function printPrivacyChange(ctx: CliContext, before: ArtifactView, after: ArtifactView): void {
  printLine(ctx, `  ${shortId(after.id)}  ${displayTitle(after.title)}`)
  printLine(ctx, `  ${before.visibility} → ${after.visibility}`)
  printLine(ctx, PRIVACY_OUTCOME[after.visibility])
}

export async function runRemove(options: RemoveOptions, ctx: CliContext): Promise<ExitCode> {
  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    await client.remove(`/api/v1/artifacts/${id}`)

    if (options.isJson === true) {
      printJson(ctx, { id, deleted: true }, JSON_INDENT)
      return EXIT_OK
    }
    printLine(ctx, `✓ moved ${shortId(id)} to trash`)
    // The full id, not the prefix: a trashed artifact leaves GET /v1/artifacts, so a prefix has
    // nothing left to resolve against.
    printLine(ctx, `  restore with: enclave restore ${id}`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}

export async function runRestore(options: RestoreOptions, ctx: CliContext): Promise<ExitCode> {
  try {
    const client = requireClient(options.host, ctx, options.isInsecureAllowed)
    const id = await resolveArtifactId(client, options.id)
    const artifact = await client.post<ArtifactView>(
      `/api/v1/artifacts/${id}/restore`,
      // No body: the route reads none, and sending one would add a content-type it never asked for.
      undefined,
    )

    if (options.isJson === true) printJson(ctx, artifact, JSON_INDENT)
    else printLine(ctx, `✓ restored ${shortId(artifact.id)}  ${displayTitle(artifact.title)}`)
    return EXIT_OK
  } catch (error) {
    return reportFailure(error, ctx, failureFor(options.host, options.isJson, options.id))
  }
}
