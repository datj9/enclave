import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import type { BundleFile, SkippedFile, SkipReason } from './types.ts'

/** Mirrors CONTENT_TYPE_BY_EXTENSION in src/lib/bundle/validate.ts. The server stays authoritative. */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  'html', 'css', 'js', 'mjs', 'json', 'svg',
  'png', 'jpg', 'jpeg', 'webp', 'woff2', 'txt', 'md',
])

/** Mirrors PATH_PATTERN in src/lib/bundle/validate.ts. */
const PATH_PATTERN = /^[a-zA-Z0-9._\-/]{1,200}$/

const ALWAYS_IGNORED_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', '.git'])

const MAX_FILE_BYTES = 2_097_152

export const ENTRY_PATH = 'index.html'

export interface CollectResult {
  readonly files: readonly BundleFile[]
  readonly skipped: readonly SkippedFile[]
}

function extensionOf(path: string): string | undefined {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0) return undefined
  return fileName.slice(dotIndex + 1).toLowerCase()
}

function isPathAllowed(path: string): boolean {
  if (!PATH_PATTERN.test(path)) return false
  if (path.startsWith('/')) return false
  if (path.includes('..')) return false
  return !path.includes('//')
}

/** gitignore-lite: one glob per line, `#` comments, `*` matches within a segment, `/` anchors. */
function compileIgnorePatterns(source: string): readonly RegExp[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const anchored = line.startsWith('/')
      const body = anchored ? line.slice(1) : line
      const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      const expanded = escaped.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
      return new RegExp(anchored ? `^${expanded}$` : `(^|/)${expanded}$`)
    })
}

function readIgnorePatterns(directory: string): readonly RegExp[] {
  const candidate = join(directory, '.enclaveignore')
  if (!existsSync(candidate)) return []
  return compileIgnorePatterns(readFileSync(candidate, 'utf8'))
}

interface Candidate {
  readonly absolutePath: string
  readonly relativePath: string
  readonly isSymbolicLink: boolean
}

function walk(root: string, current: string, found: Candidate[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name)
    const relativePath = relative(root, absolutePath).split(sep).join('/')

    if (entry.isSymbolicLink()) {
      found.push({ absolutePath, relativePath, isSymbolicLink: true })
      continue
    }
    if (entry.isDirectory()) {
      if (ALWAYS_IGNORED_SEGMENTS.has(entry.name) || entry.name.startsWith('.')) {
        found.push({ absolutePath, relativePath, isSymbolicLink: false })
        continue
      }
      walk(root, absolutePath, found)
      continue
    }
    if (entry.isFile()) found.push({ absolutePath, relativePath, isSymbolicLink: false })
  }
}

function classify(
  candidate: Candidate,
  ignorePatterns: readonly RegExp[],
): SkipReason | null {
  const segments = candidate.relativePath.split('/')
  if (segments.some((segment) => ALWAYS_IGNORED_SEGMENTS.has(segment) || segment.startsWith('.'))) {
    return 'ignored'
  }
  if (ignorePatterns.some((pattern) => pattern.test(candidate.relativePath))) return 'ignored'
  if (candidate.isSymbolicLink) return 'ignored'
  if (!isPathAllowed(candidate.relativePath)) return 'invalid_path'

  const extension = extensionOf(candidate.relativePath)
  if (extension === undefined || !ALLOWED_EXTENSIONS.has(extension)) return 'unsupported_extension'

  if (lstatSync(candidate.absolutePath).size > MAX_FILE_BYTES) return 'too_large'
  return null
}

/**
 * Classification order is load-bearing: `ignored` outranks `invalid_path`, so a dotfile with a
 * space in its name reports as ignored rather than as a path error the user cannot act on.
 */
export function collectBundle(directory: string): CollectResult {
  const candidates: Candidate[] = []
  walk(directory, directory, candidates)
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const ignorePatterns = readIgnorePatterns(directory)
  const files: BundleFile[] = []
  const skipped: SkippedFile[] = []

  for (const candidate of candidates) {
    const reason = classify(candidate, ignorePatterns)
    if (reason !== null) {
      skipped.push({ path: candidate.relativePath, reason })
      continue
    }
    files.push({
      path: candidate.relativePath,
      content: readFileSync(candidate.absolutePath),
    })
  }

  return { files, skipped }
}
