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
  readonly isInsecureAllowed?: boolean
  readonly userAgent?: string
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
