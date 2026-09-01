import { env } from '@/env'

import { artifactPageUrl } from './naming'

/**
 * Everything the two origins of grill-result §4.1 need to recognise each other: which host is an
 * artifact origin, which artifact it belongs to, and the CSP source expressions that name them.
 *
 * Imported by `proxy.ts`, so it must stay free of database and storage imports.
 */

/** A legal DNS label, so `new URL()` leaves it intact while the template is parsed. */
const ID_SLOT = 'artifactidslot'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Internal path the proxy rewrites an artifact-origin request onto, and the one path on an
 * artifact origin that is reserved rather than served from the bundle (§4.2 step 4).
 *
 * The prefix cannot start with `_`: Next.js treats such a folder as private and never routes
 * it, which is also why the public `/__enter` maps to an `enter` segment here.
 */
export const ARTIFACT_ROUTE_PREFIX = '/artifact-origin'
export const ARTIFACT_ENTER_PATH = '/__enter'

function templateHost(template: string): string {
  return new URL(template.replaceAll('{id}', ID_SLOT)).host
}

function hostPattern(template: string): RegExp {
  const escaped = templateHost(template).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(ID_SLOT, '([^.]+)')}$`)
}

let cachedPattern: { readonly template: string; readonly pattern: RegExp } | undefined

/** The real host of the request, mirroring how Next.js itself resolves it behind a proxy. */
export function requestHost(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-host')
  const host = forwarded?.split(',')[0]?.trim() ?? request.headers.get('host')
  return host === undefined || host === null || host === '' ? null : host.toLowerCase()
}

/**
 * `null` for the app origin and for anything that merely looks like an artifact host. The id has
 * to be a UUID: it is the unguessable part of the origin (§4.1) and it reaches Postgres as one.
 */
export function artifactIdFromHost(host: string | null): string | null {
  if (host === null) return null

  const template = env.ARTIFACT_ORIGIN_TEMPLATE
  if (cachedPattern?.template !== template) {
    cachedPattern = { template, pattern: hostPattern(template) }
  }

  const candidate = cachedPattern.pattern.exec(host)?.[1]
  return candidate !== undefined && UUID_PATTERN.test(candidate) ? candidate : null
}

/** The one origin allowed to frame an artifact — the `frame-ancestors` value of §4.3. */
export function appOrigin(): string {
  return new URL(env.APP_URL).origin
}

/** Every artifact origin at once, for the app CSP's `frame-src`. */
export function artifactOriginPattern(): string {
  const url = new URL(env.ARTIFACT_ORIGIN_TEMPLATE.replaceAll('{id}', ID_SLOT))
  return `${url.protocol}//${url.host.replace(ID_SLOT, '*')}`
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
} as const

/** Shared by the redirect and the re-entry page so a cached bounce cannot outlive the grant. */
const ENTRY_VARY = 'cookie, sec-fetch-dest, accept'

function artifactOriginPage(status: number, message: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>enclave</title><p>${message}</p>`
  return new Response(body, { status, headers: HTML_HEADERS })
}

/**
 * How the browser asked for this artifact-origin URL. Decides whether a grant miss may point at
 * app-origin HTML (top-level / framed) or must stay the bare 404 (subresource).
 */
export type ArtifactEntryIntent = 'top-level' | 'framed' | 'subresource'

/**
 * Classifies from `Sec-Fetch-Dest`, falling back to `Accept` when the header is absent.
 * The fallback resolves to 'framed', never 'top-level': the re-entry page works in both
 * contexts, a redirect would be a blank frame in one of them.
 */
export function artifactEntryIntent(headers: Headers): ArtifactEntryIntent {
  const dest = headers.get('sec-fetch-dest')
  if (dest === 'document') return 'top-level'
  if (dest === 'iframe' || dest === 'frame') return 'framed'
  // object/embed included here deliberately: frame-src names iframes only, so they get the bare 404, not the interstitial.
  if (dest !== null && dest !== '') return 'subresource'

  // No Sec-Fetch-Dest (old Safari, curl, bots): first Accept type starting with text/html →
  // framed, otherwise subresource. Never top-level — safer when the signal is missing (§3.2).
  const accept = headers.get('accept')
  if (accept === null || accept === '') return 'subresource'
  const firstType = accept.split(',')[0]?.trim().split(';')[0]?.trim() ?? ''
  return firstType.startsWith('text/html') ? 'framed' : 'subresource'
}

/**
 * Re-entry interstitial for a framed (or Accept-fallback) grant miss. Same 404 status as every
 * other framed/subresource failure so the status line discloses nothing new. Survives the
 * artifact CSP: one inline style, one blank-target link, no script, no form, no external resource
 * (§3.1). Tokens inlined from design.md — the app stylesheet cannot be loaded from this origin.
 */
function artifactReentryPage(artifactId: string): Response {
  const href = artifactPageUrl(artifactId)
  const body = `<!doctype html><meta charset="utf-8"><title>enclave</title><style>:root{--color-paper:oklch(97% 0.008 60);--color-ink:oklch(19% 0.010 60);--color-ink-2:oklch(44% 0.008 60);--color-accent:oklch(53% 0.130 55)}@media (prefers-color-scheme:dark){:root{--color-paper:oklch(15% 0.010 60);--color-ink:oklch(94% 0.006 70);--color-ink-2:oklch(72% 0.006 60);--color-accent:oklch(70% 0.130 55)}}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--color-paper);color:var(--color-ink);font:400 1rem/1.55 ui-sans-serif,system-ui,sans-serif;padding:1.5rem}main{max-width:36rem}h1{font-size:1.25rem;font-weight:700;line-height:1.25;margin:0 0 0.75rem}p{margin:0 0 1.25rem;color:var(--color-ink-2)}a{color:var(--color-accent)}</style><main><h1>This artifact needs to be reopened</h1><p>Artifacts are served from their own address and need a fresh entry from enclave.</p><a href="${href}" target="_blank" rel="noopener noreferrer">Open this artifact</a></main>`
  return new Response(body, {
    status: 404,
    headers: { ...HTML_HEADERS, vary: ENTRY_VARY },
  })
}

/**
 * The single response for "this origin cannot authorize you, and does not know why".
 * `artifactId` comes from the request host and is therefore already a validated UUID.
 *
 * This helper must only ever be called before the route's first database call. It answers
 * identically for an artifact that exists and one that never did, and that property holds only
 * because nothing above the call site has consulted Postgres or object storage. Adding any lookup
 * above a call site turns this into an existence oracle (§7).
 */
export function artifactEntryUnavailable(artifactId: string, headers: Headers): Response {
  const intent = artifactEntryIntent(headers)
  if (intent === 'top-level') {
    // cache-control: no-store is not optional — a cached redirect for `/` would keep bouncing the
    // viewer to `/a/{id}` after the grant cookie exists. vary is belt and braces on top of it.
    return new Response(null, {
      status: 302,
      headers: {
        location: artifactPageUrl(artifactId),
        'cache-control': 'no-store',
        vary: ENTRY_VARY,
      },
    })
  }
  if (intent === 'framed') {
    return artifactReentryPage(artifactId)
  }
  return artifactNotAvailable()
}

/**
 * The single failure response of the artifact origin. Unauthorized, revoked, replayed, wrong
 * host and unknown path all collapse to the same 404 so nothing on this origin distinguishes
 * "exists but you may not read it" from "does not exist".
 */
export function artifactNotAvailable(): Response {
  return artifactOriginPage(404, 'This artifact is no longer available.')
}

/** §7: storage down during a view — a plain page, no stack trace and no bucket name. */
export function artifactStorageUnavailable(): Response {
  return artifactOriginPage(503, 'This artifact cannot be loaded right now. Please retry.')
}
