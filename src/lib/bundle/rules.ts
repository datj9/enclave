/**
 * What a bundle is allowed to contain, in one place.
 *
 * The server enforces these (`validateBundle`) and the CLI pre-applies them so a push does not
 * spend an upload to learn a file was never going to be accepted. Those were separate copies until
 * they were not: the same regex and the same two helpers existed in `validate.ts` and in
 * `packages/push-core/src/collect.ts`, and nothing would have caught them drifting apart.
 *
 * A drifted client that accepted MORE than the server is the failure that matters, so this module
 * is the single definition rather than two that happen to agree today.
 *
 * It imports nothing on purpose. `validate.ts` pulls in `@/env`, which would drag the server's
 * environment validation into a CLI that has no `DATABASE_URL` and does not need one.
 */

/** §4.4: an object's `Content-Type` comes from this map, never from sniffing the bytes. */
export const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
  txt: 'text/plain',
  md: 'text/markdown',
}

export const PATH_PATTERN = /^[a-zA-Z0-9._\-/]{1,200}$/

/** The document the browser loads at the artifact origin's root. */
export const ENTRY_PATH = 'index.html'

export function extensionOf(path: string): string | undefined {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const dotIndex = fileName.lastIndexOf('.')
  // -1 is "no extension"; 0 is a dotfile, which has no extension either.
  if (dotIndex <= 0) return undefined
  return fileName.slice(dotIndex + 1).toLowerCase()
}

/**
 * The character class already rejects `\` and null bytes. A leading `/`, `..` and `//` need their
 * own checks because each of those characters is legal on its own.
 */
export function isPathAllowed(path: string): boolean {
  if (!PATH_PATTERN.test(path)) return false
  if (path.startsWith('/')) return false
  if (path.includes('..')) return false
  return !path.includes('//')
}
