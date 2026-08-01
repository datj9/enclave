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

export interface ObjectStore {
  /** Idempotent. Safe to call on every boot and from two processes at once. */
  ensureBucket(): Promise<void>
  putObject(input: PutObjectInput): Promise<void>
  getObject(key: string): Promise<FetchedObject | undefined>
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
