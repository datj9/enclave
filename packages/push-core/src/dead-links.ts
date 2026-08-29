import { posix } from 'node:path'

import { extensionOf } from '../../../src/lib/bundle/rules.ts'
import type { BundleFile } from './types.ts'

export interface DeadLink {
  /** The html file that carries the reference. */
  readonly from: string
  /** The bundle-relative path it resolves to, which no file in the bundle provides. */
  readonly to: string
}

const REFERENCE_PATTERN = /\b(?:href|src)\s*=\s*["']([^"']*)["']/g

/** `:` before the first `/` is the whole scheme test: `https:` and `mailto:` both pass it, and a
 *  relative path never contains `:`. A leading `/` — `//` included — may be served by a route. */
function isExternalReference(reference: string): boolean {
  if (reference.startsWith('#')) return true
  if (reference.startsWith('/')) return true
  const colonIndex = reference.indexOf(':')
  const slashIndex = reference.indexOf('/')
  return colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)
}

/**
 * The origin's directory-index behaviour is the server's business, not this check's: a reference
 * that points at a directory rather than a file is skipped, and one that walks above the bundle
 * root resolves to nothing in the manifest, which is reported like any other miss.
 */
function resolveReference(from: string, reference: string): string | null {
  const stripped = reference.split(/[?#]/, 1)[0]
  if (
    stripped === undefined ||
    stripped === '' ||
    stripped.endsWith('/') ||
    stripped === '.' ||
    stripped === '..'
  ) {
    return null
  }
  const directory = from.slice(0, from.lastIndexOf('/') + 1)
  const resolved = posix.normalize(directory + stripped)
  if (resolved === '' || resolved === '.' || resolved.endsWith('/')) return null
  return resolved
}

/**
 * A push is the only moment the whole bundle is in hand, and the artifact origin 404s an
 * unmatched path with a page that names nothing — so a link the bundle cannot satisfy is worth
 * saying out loud before it ships. `\u0000` separates the two paths so `from` and `to` cannot
 * collide in the dedup key; one nav repeated in ten pages is ten entries, the same href twice in
 * one file is one.
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