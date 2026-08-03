import { collectBundle } from './collect.ts'
import { PushError } from './errors.ts'
import { normaliseHost } from './host.ts'
import type { BundleFile, PushOptions, PushResult } from './types.ts'
import { assertBundlePushable } from './validate-local.ts'

interface WireFile {
  readonly path: string
  readonly content?: string
  readonly contentBase64?: string
}

interface CreateArtifactResponse {
  readonly id: string
  readonly versionId: string
  readonly viewUrl: string
}

/** The server's envelope is `{data:…}` on success; anything else is a transport fault. */
function unwrapCreateResponse(body: unknown): CreateArtifactResponse {
  if (typeof body !== 'object' || body === null || !('data' in body)) {
    throw new PushError('UNEXPECTED_RESPONSE', 'Response is missing a data envelope', {})
  }
  const data = (body as { data: unknown }).data
  if (typeof data !== 'object' || data === null) {
    throw new PushError('UNEXPECTED_RESPONSE', 'Response data is not an object', {})
  }
  const { id, versionId, viewUrl } = data as Record<string, unknown>
  if (typeof id !== 'string' || typeof versionId !== 'string' || typeof viewUrl !== 'string') {
    throw new PushError('UNEXPECTED_RESPONSE', 'Response is missing id, versionId or viewUrl', {})
  }
  return { id, versionId, viewUrl }
}

/** Send utf-8 when the bytes round-trip losslessly; the server rejects both fields at once. */
function toWireFile(file: BundleFile): WireFile {
  const text = file.content.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(file.content)) return { path: file.path, content: text }
  return { path: file.path, contentBase64: file.content.toString('base64') }
}

export function baseUrlFor(host: string, isInsecureAllowed = false): string {
  return normaliseHost(host, isInsecureAllowed)
}

async function errorFrom(response: Response): Promise<PushError> {
  let code = 'UNEXPECTED_RESPONSE'
  let message = `The server returned ${String(response.status)}`
  let details: Record<string, unknown> = {}

  try {
    const body: unknown = await response.json()
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const envelope = (body as { error: { code?: string; message?: string; details?: unknown } })
        .error
      if (typeof envelope.code === 'string') code = envelope.code
      if (typeof envelope.message === 'string') message = envelope.message
      if (typeof envelope.details === 'object' && envelope.details !== null) {
        details = envelope.details as Record<string, unknown>
      }
    }
  } catch {
    // A non-JSON body carries nothing worth surfacing; the status already did.
  }

  if (response.status === 401) return new PushError('UNAUTHORIZED', message, details)
  if (response.status === 404) return new PushError('NOT_FOUND', message, details)
  return new PushError(code as PushError['code'], message, details)
}

export async function push(options: PushOptions): Promise<PushResult> {
  const { files, skipped } = collectBundle(options.directory)
  assertBundlePushable(files, skipped)

  const body = JSON.stringify({
    title: options.title ?? 'Untitled artifact',
    visibility: options.visibility ?? 'private',
    files: files.map(toWireFile),
  })

  const url = baseUrlFor(options.host, options.isInsecureAllowed ?? false)
  let response: Response
  try {
    response = await fetch(`${url}/api/v1/artifacts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
      },
      body,
    })
  } catch {
    throw new PushError('NETWORK_ERROR', 'Could not reach the server', { host: options.host })
  }

  if (!response.ok) throw await errorFrom(response)

  const created = unwrapCreateResponse(await response.json())
  return {
    artifactId: created.id,
    versionId: created.versionId,
    versionNo: 1,
    viewUrl: created.viewUrl,
    uploaded: files.map((file) => file.path),
    skipped,
  }
}
