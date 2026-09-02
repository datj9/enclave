import { posix } from 'node:path'

import { extensionOf } from '../../../src/lib/bundle/rules.ts'
import type { BundleFile } from './types.ts'

export interface DeadLink {
  /** The html file that carries the reference. */
  readonly from: string
  /** The bundle-relative path it resolves to, which no file in the bundle provides. */
  readonly to: string
}

/**
 * `(?<![-\w])` rather than `\b`: `-` is not a word character, so `\b` matches inside `data-href`
 * and reports a value no browser will ever fetch. `:` stays permitted before the name, which is
 * what keeps `xlink:href` on a `<use>` — a real fetch — in scope. The `i` flag because HTML
 * attribute names are case-insensitive: `<a HREF="…">` is the same link.
 */
const REFERENCE_PATTERN = /(?<![-\w])(?:href|src)\s*=\s*["']([^"']*)["']/gi

/**
 * The one path on an artifact origin that is reserved rather than served from the bundle. Copied
 * from `src/lib/artifacts/origin.ts` rather than imported: that module pulls in `@/env`, which
 * validates server environment on import and has no business inside the CLI.
 */
const ORIGIN_RESERVED_PATH = '/__enter'

/** `:` before the first `/` is the whole scheme test: `https:` and `mailto:` both pass it, and a
 *  relative path never contains `:`. `//host/x` is another origin; a *single* leading `/` is not.
 *  The proxy rewrites every artifact-origin path onto the bundle, so the root is the bundle. */
function isExternalReference(reference: string): boolean {
  if (reference.startsWith('#')) return true
  if (reference.startsWith('//')) return true
  const colonIndex = reference.indexOf(':')
  const slashIndex = reference.indexOf('/')
  return colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)
}

/**
 * A browser clamps `..` at the origin root: from `/docs/a.html`, `../../x.html` is a request for
 * `/x.html`. `posix.normalize` keeps the `../` prefix instead, which both reads as a filesystem
 * path in the warning and reports dead a link that in fact resolves onto a file the bundle has.
 */
function clampToRoot(path: string): string {
  let clamped = path
  while (clamped.startsWith('../')) clamped = clamped.slice(3)
  return clamped === '..' ? '' : clamped
}

/**
 * The origin's directory-index behaviour is the server's business, not this check's: a reference
 * that points at a directory rather than a file is skipped, `/` included — the serve route answers
 * it with the manifest's entry path, which every pushable bundle has.
 *
 * A root-absolute reference resolves against the bundle root, not the referring file's directory,
 * because that is what the proxy does with it: every pathname but `/__enter` is rewritten onto
 * `/serve<pathname>` and matched against the manifest exactly.
 */
function resolveReference(from: string, reference: string): string | null {
  const stripped = reference.split(/[?#]/, 1)[0]
  if (
    stripped === undefined ||
    stripped === '' ||
    stripped.endsWith('/') ||
    stripped === '.' ||
    stripped === '..' ||
    stripped === ORIGIN_RESERVED_PATH
  ) {
    return null
  }
  const isRootAbsolute = stripped.startsWith('/')
  const directory = isRootAbsolute ? '' : from.slice(0, from.lastIndexOf('/') + 1)
  const resolved = clampToRoot(
    posix.normalize(directory + (isRootAbsolute ? stripped.slice(1) : stripped)),
  )
  if (resolved === '' || resolved === '.' || resolved.endsWith('/')) return null
  return resolved
}

/**
 * A push is the only moment the whole bundle is in hand, and the artifact origin 404s an
 * unmatched path with a page that names nothing — so a link the bundle cannot satisfy is worth
 * saying out loud before it ships. `\u0000` separates the two paths so `from` and `to` cannot
 * collide in the dedup key; one nav repeated in ten pages is ten entries, the same href twice in
 * one file is one.
 *
 * A scan, not a parse, and warn-only for that reason. It reads markup a browser would never
 * execute — a reference inside an html comment or a `<script>` string literal is reported — and
 * it misses an unquoted `href=gone.html`, a value built at runtime, and `srcset`. A parser would
 * fix the first two, nothing would fix the third, and none of it can fail a push.
 */
export function findDeadLinks(files: readonly BundleFile[]): readonly DeadLink[] {
  const present = new Set(files.map((file) => file.path))
  const seen = new Set<string>()
  const links: DeadLink[] = []

  for (const file of files) {
    if (extensionOf(file.path) !== 'html') continue

    const html = file.content.toString('utf8')
    for (const match of html.matchAll(REFERENCE_PATTERN)) {
      const reference = match[1]
      if (reference === undefined || isExternalReference(reference)) continue

      const resolved = resolveReference(file.path, reference)
      if (resolved === null || present.has(resolved)) continue

      const key = `${file.path}\u0000${resolved}`
      if (seen.has(key)) continue
      seen.add(key)

      links.push({ from: file.path, to: resolved })
    }
  }

  links.sort((left, right) => {
    const byFrom = left.from.localeCompare(right.from)
    return byFrom !== 0 ? byFrom : left.to.localeCompare(right.to)
  })
  return links
}