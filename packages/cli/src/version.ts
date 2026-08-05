import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface PackageManifest {
  readonly version?: unknown
}

/**
 * Not `0.0.0`: a plausible-looking version is exactly the failure the `--version` issue was about,
 * because a bug report then names a build that was never published. `unknown` is unmistakable.
 */
export const UNKNOWN_VERSION = 'unknown'
const MAX_ANCESTORS = 8

/**
 * Walks up from this file's own directory rather than assuming a fixed depth: the source tree
 * (`packages/cli/src`) and the published tarball (`dist/packages/cli/src`, package.json at the
 * tarball root) put package.json a different number of levels up, and only a search finds it
 * correctly in both.
 */
function findPackageJson(startDirectory: string): string | null {
  let directory = startDirectory
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const candidate = join(directory, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return null
}

export function cliVersion(): string {
  const path = findPackageJson(dirname(fileURLToPath(import.meta.url)))
  if (path === null) return UNKNOWN_VERSION
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
    return typeof manifest.version === 'string' ? manifest.version : UNKNOWN_VERSION
  } catch {
    return UNKNOWN_VERSION
  }
}

/** The published package name, not the binary name — server-side triage greps for what npm shows. */
export const USER_AGENT = `enclave-artifacts/${cliVersion()}`
