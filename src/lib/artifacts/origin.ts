import { env } from '@/env'

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

function artifactOriginPage(status: number, message: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>enclave</title><p>${message}</p>`
  return new Response(body, { status, headers: HTML_HEADERS })
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
