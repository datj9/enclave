/**
 * The storage port every caller depends on, and the key layout from grill-result §4.4. No
 * `@aws-sdk` import here on purpose: routes, jobs and their tests talk to this interface, and
 * only `s3.ts` knows about a driver.
 */

export interface PutObjectInput {
  readonly key: string
  readonly body: Buffer
  readonly contentType: string
}

export interface FetchedObject {
  readonly body: Buffer
  readonly contentType: string
}

export interface StreamedObject {
  readonly body: ReadableStream<Uint8Array>
  readonly contentType: string
  readonly contentLength: number | undefined
}

export interface ObjectStore {
  /** Idempotent. Safe to call on every boot and from two processes at once. */
  ensureBucket(): Promise<void>
  putObject(input: PutObjectInput): Promise<void>
  getObject(key: string): Promise<FetchedObject | undefined>
  /**
   * The artifact entry document is the one object the app process serves itself (§4.2 step 5),
   * so it must reach the client without being buffered whole — a 2 MB file inside the limits
   * would otherwise sit in the app's heap (§7).
   */
  getObjectStream(key: string): Promise<StreamedObject | undefined>
  /** Asset bytes never pass through the app process; viewers are redirected here (§4.2 step 6). */
  presignGetUrl(key: string, expiresInSeconds: number): Promise<string>
  listKeys(prefix: string): Promise<readonly string[]>
  deletePrefix(prefix: string): Promise<void>
}

/** `artifacts/{artifactId}/{versionId}/` — objects under a version are never mutated (§4.4). */
export function versionPrefix(artifactId: string, versionId: string): string {
  return `artifacts/${artifactId}/${versionId}/`
}

export function storageKey(artifactId: string, versionId: string, path: string): string {
  return `${versionPrefix(artifactId, versionId)}${path}`
}
