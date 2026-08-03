import { ENTRY_PATH } from './collect.ts'
import { PushError } from './errors.ts'
import type { BundleFile, SkippedFile } from './types.ts'

/**
 * Mirrors the server's default bundle limits (`BUNDLE_MAX_FILES` / `BUNDLE_MAX_TOTAL_BYTES` in
 * `src/env.ts`) without importing server env — this is a client-side convenience gate so
 * `--dry-run` and a real push agree, not the source of truth. The server still validates every
 * upload and may reject one this let through if an instance has lowered its own limits.
 */
export const DEFAULT_MAX_FILES = 50
export const DEFAULT_MAX_TOTAL_BYTES = 10_485_760

/** Refuses the same bundle a real push would refuse, before either spends a request on it. */
export function assertBundlePushable(
  files: readonly BundleFile[],
  skipped: readonly SkippedFile[],
): void {
  if (files.length === 0) {
    throw new PushError('NOTHING_TO_UPLOAD', 'No file in that directory can be uploaded', {
      skipped,
    })
  }
  if (!files.some((file) => file.path === ENTRY_PATH)) {
    throw new PushError('ENTRY_MISSING', `The bundle needs an ${ENTRY_PATH} at its root`, {
      skipped,
    })
  }
  if (files.length > DEFAULT_MAX_FILES) {
    throw new PushError(
      'BUNDLE_TOO_LARGE',
      `The bundle has ${String(files.length)} files, more than the ${String(DEFAULT_MAX_FILES)} allowed`,
      { fileCount: files.length, maxFiles: DEFAULT_MAX_FILES },
    )
  }

  const totalBytes = files.reduce((total, file) => total + file.content.length, 0)
  if (totalBytes > DEFAULT_MAX_TOTAL_BYTES) {
    throw new PushError(
      'BUNDLE_TOO_LARGE',
      `The bundle is ${String(totalBytes)} bytes, more than the ${String(DEFAULT_MAX_TOTAL_BYTES)} allowed`,
      { totalBytes, maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES },
    )
  }
}
