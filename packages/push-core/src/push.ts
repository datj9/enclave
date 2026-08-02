import { collectBundle, ENTRY_PATH } from './collect.ts'
import { PushError } from './errors.ts'
import { normaliseHost } from './host.ts'
import type { BundleFile, PushOptions, PushResult } from './types.ts'

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

  const created = (await response.json()) as CreateArtifactResponse
  return {
    artifactId: created.id,
    versionId: created.versionId,
    versionNo: 1,
    viewUrl: created.viewUrl,
    uploaded: files.map((file) => file.path),
    skipped,
  }
}
