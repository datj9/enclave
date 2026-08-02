import { createHash } from 'node:crypto'

import { env } from '@/env'
import {
  CONTENT_TYPE_BY_EXTENSION,
  ENTRY_PATH,
  extensionOf,
  isPathAllowed,
} from '@/lib/bundle/rules'
import type { ErrorCode } from '@/lib/http'

// Re-exported so existing importers keep their current specifier; `rules.ts` is the definition.
export { CONTENT_TYPE_BY_EXTENSION, ENTRY_PATH }

/**
 * The bundle gate, per grill-result §5.5. Pure: no storage, no database, no environment unless
 * the caller omits `limits`. Every branch here maps to an acceptance criterion in S2.
 */

export interface BundleFile {
  readonly path: string
  readonly content: Buffer
}

/** Stored verbatim as `artifact_versions.manifest` jsonb, so the keys stay snake_case (§5.2). */
export interface ManifestEntry {
  readonly path: string
  readonly bytes: number
  readonly content_type: string
  readonly sha256: string
}

export type BundleValidation =
  | { readonly ok: true; readonly manifest: readonly ManifestEntry[] }
  | { readonly ok: false; readonly code: ErrorCode; readonly details: Record<string, unknown> }

export interface BundleLimits {
  readonly maxFiles: number
  readonly maxFileBytes: number
  readonly maxTotalBytes: number
}

export function bundleLimitsFromEnv(): BundleLimits {
  return {
    maxFiles: env.BUNDLE_MAX_FILES,
    maxFileBytes: env.BUNDLE_MAX_FILE_BYTES,
    maxTotalBytes: env.BUNDLE_MAX_TOTAL_BYTES,
  }
}

type FileOutcome =
  | { readonly ok: true; readonly entry: ManifestEntry }
  | { readonly ok: false; readonly code: ErrorCode; readonly details: Record<string, unknown> }

function validateFile(file: BundleFile, maxFileBytes: number): FileOutcome {
  if (!isPathAllowed(file.path)) {
    return { ok: false, code: 'PATH_INVALID', details: { path: file.path } }
  }

  const extension = extensionOf(file.path)
  const contentType = extension === undefined ? undefined : CONTENT_TYPE_BY_EXTENSION[extension]
  if (contentType === undefined) {
    return { ok: false, code: 'FILE_TYPE_NOT_ALLOWED', details: { path: file.path } }
  }

  const bytes = file.content.byteLength
  if (bytes > maxFileBytes) {
    return {
      ok: false,
      code: 'BUNDLE_TOO_LARGE',
      details: { path: file.path, bytes, maxFileBytes },
    }
  }

  const sha256 = createHash('sha256').update(file.content).digest('hex')
  return { ok: true, entry: { path: file.path, bytes, content_type: contentType, sha256 } }
}

export function validateBundle(
  files: readonly BundleFile[],
  limits: BundleLimits = bundleLimitsFromEnv(),
): BundleValidation {
  if (files.length === 0) {
    return { ok: false, code: 'VALIDATION_FAILED', details: { reason: 'bundle_empty' } }
  }
  if (files.length > limits.maxFiles) {
    return {
      ok: false,
      code: 'BUNDLE_TOO_LARGE',
      details: { fileCount: files.length, maxFiles: limits.maxFiles },
    }
  }

  const manifest: ManifestEntry[] = []
  const seenPaths = new Set<string>()
  let totalBytes = 0

  for (const file of files) {
    if (seenPaths.has(file.path)) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        details: { reason: 'duplicate_path', path: file.path },
      }
    }

    const outcome = validateFile(file, limits.maxFileBytes)
    if (!outcome.ok) return outcome

    totalBytes += outcome.entry.bytes
    if (totalBytes > limits.maxTotalBytes) {
      return {
        ok: false,
        code: 'BUNDLE_TOO_LARGE',
        details: { totalBytes, maxTotalBytes: limits.maxTotalBytes },
      }
    }

    seenPaths.add(file.path)
    manifest.push(outcome.entry)
  }

  if (!seenPaths.has(ENTRY_PATH)) {
    return { ok: false, code: 'ENTRY_MISSING', details: { expected: ENTRY_PATH } }
  }

  return { ok: true, manifest }
}
