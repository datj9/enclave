import type { CollectResult } from './collect.ts'

/** Why `collectBundle` left a file out of the upload. */
export type SkipReason = 'unsupported_extension' | 'invalid_path' | 'ignored' | 'too_large'

export interface SkippedFile {
  readonly path: string
  readonly reason: SkipReason
}

export interface BundleFile {
  readonly path: string
  readonly content: Buffer
}

export type Visibility = 'private' | 'org' | 'public'

/** What is about to go on the wire, measured after the bundle passed validation. */
export interface UploadPlan {
  readonly fileCount: number
  readonly totalBytes: number
}

export interface PushOptions {
  readonly directory: string
  readonly host: string
  readonly token: string
  readonly title?: string
  readonly visibility?: Visibility
  /** Present => republish this artifact as a new version instead of creating one. */
  readonly artifactId?: string
  /** Omitted => unconditional republish, the --force path. Only meaningful with `artifactId`. */
  readonly expectedVersionNo?: number
  readonly isInsecureAllowed?: boolean
  readonly userAgent?: string
  /** The bundle, already collected. A caller that had to read the directory for its own checks
   *  passes it here rather than making `push` walk and read all of it a second time. Omitted =>
   *  `push` collects `directory` itself, which is the standalone case. */
  readonly bundle?: CollectResult
  /** `push` already holds the files, so a caller announcing the upload need not re-read the directory. */
  readonly onUploadStart?: (plan: UploadPlan) => void
}

export interface PushResult {
  readonly artifactId: string
  readonly versionId: string
  readonly versionNo: number
  readonly viewUrl: string
  readonly uploaded: readonly string[]
  readonly skipped: readonly SkippedFile[]
}
