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

export type Visibility = 'private' | 'org'

export interface PushOptions {
  readonly directory: string
  readonly host: string
  readonly token: string
  readonly title?: string
  readonly visibility?: Visibility
  readonly isInsecureAllowed?: boolean
}

export interface PushResult {
  readonly artifactId: string
  readonly versionId: string
  readonly versionNo: number
  readonly viewUrl: string
  readonly uploaded: readonly string[]
  readonly skipped: readonly SkippedFile[]
}
