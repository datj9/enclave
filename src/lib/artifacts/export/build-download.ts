import { env } from '@/env'
import type { AuthorizedVersion } from '@/lib/artifacts/authorize'
import { HttpError } from '@/lib/http'
import { storageKey, type ObjectStore } from '@/lib/storage/object-store'
import { htmlToMarkdown } from './html-to-markdown'
import { inlineBundle } from './inline-html'

/**
 * The shared core of both download routes — the part that turns an `AuthorizedVersion` (already
 * past the read gate) into the bytes of a download, in one of the two formats. Pure over the
 * injected `ObjectStore`, so every branch is reachable from a unit test with a fake store.
 *
 * Order is fixed: the size cap first (no bytes for an oversize artifact), the entry document
 * second (every format needs it), the format conversion last.
 */

export type DownloadFormat = 'md' | 'html'

export interface DownloadResult {
  readonly body: string
  readonly contentType: string
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

export async function buildDownload(
  authorized: AuthorizedVersion,
  format: DownloadFormat,
  store: ObjectStore,
): Promise<DownloadResult> {
  const totalBytes = authorized.manifest.reduce((sum, entry) => sum + entry.bytes, 0)
  if (totalBytes > env.BUNDLE_MAX_TOTAL_BYTES) {
    throw new HttpError('BUNDLE_TOO_LARGE', 'artifact too large to export')
  }

  const entryObject = await store.getObject(
    storageKey(authorized.artifactId, authorized.versionId, authorized.entryPath),
  )
  // The manifest said the entry exists; storage disagreeing is a broken bundle, not a 404 —
  // that would lie about the artifact being readable at all.
  if (entryObject === undefined) {
    throw new HttpError('ENTRY_MISSING', 'artifact entry is missing')
  }

  let rawHtml: string
  try {
    rawHtml = UTF8.decode(entryObject.body)
  } catch {
    throw new HttpError('INTERNAL_ERROR', 'artifact entry is not valid UTF-8')
  }

  if (format === 'md') {
    // Turndown over the *raw* entry HTML — never the inlined output: the .md is a text export,
    // and the inlined file would leak `data:` URIs into it.
    return { body: htmlToMarkdown(rawHtml), contentType: 'text/markdown; charset=utf-8' }
  }

  const body = await inlineBundle(
    {
      artifactId: authorized.artifactId,
      versionId: authorized.versionId,
      entryPath: authorized.entryPath,
      manifest: authorized.manifest,
    },
    store,
  )
  return { body, contentType: 'text/html; charset=utf-8' }
}