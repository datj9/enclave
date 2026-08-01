import { eq } from 'drizzle-orm'

import { db } from '@/db'
import { artifactVersions } from '@/db/schema/artifacts'
import { generations } from '@/db/schema/generations'
import { createArtifactWithBundle } from '@/lib/artifacts/create'
import { FileBlockParser, type ParseEvent } from '@/lib/bundle/parse-file-blocks'
import { HttpError } from '@/lib/http'
import type { ProviderSelection, ProviderUsage } from '@/lib/providers'
import type { ObjectStore } from '@/lib/storage/object-store'
import { objectStore } from '@/lib/storage/s3'
import { encodeSseEvent } from './sse'

/**
 * Prompt → streamed artifact, per §5.4. The order matters and is the whole slice:
 *
 *  1. a `generations` row is written before the first provider call, so an attempt is always
 *     recorded even if the process dies mid-stream;
 *  2. the first delta is pulled *before* the response is returned, so a rejected key, a 429 or a
 *     refusal is still an HTTP status with the §5.3 envelope rather than a 200 that fails later;
 *  3. everything after that is an SSE event, because the status line is already gone.
 *
 * Nothing is persisted until the parser has a complete, valid bundle: decision #23, discard the
 * partial. The prompt is written to `generations.prompt` and nowhere else — never a log line,
 * never the audit log (§8).
 */

const PROMPT_MAX_LENGTH = 4000
const TITLE_MAX_LENGTH = 80
const UNTITLED = 'Untitled artifact'

/** Not an `ErrorCode`: a disconnect is not a failure we report to anyone, only one we record. */
const CLIENT_ABORTED = 'CLIENT_ABORTED'

export interface StartGenerationInput {
  readonly userId: string
  readonly prompt: string
  readonly selection: ProviderSelection
  readonly signal: AbortSignal
  readonly actorIp?: string | null
}

export function parsePrompt(value: unknown): string {
  const prompt = typeof value === 'object' && value !== null ? Reflect.get(value, 'prompt') : undefined
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new HttpError('VALIDATION_FAILED', 'Describe what you want built')
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new HttpError('VALIDATION_FAILED', `Keep the prompt under ${PROMPT_MAX_LENGTH} characters`)
  }
  return prompt.trim()
}

/** The artifact is the user's, so its title is their own words — truncated, never logged. */
export function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split('\n')[0]?.trim() ?? ''
  if (firstLine === '') return UNTITLED
  return firstLine.length <= TITLE_MAX_LENGTH ? firstLine : `${firstLine.slice(0, TITLE_MAX_LENGTH - 1)}…`
}

function sseFromParseEvent(event: ParseEvent): Uint8Array {
  if (event.kind === 'file_start') return encodeSseEvent('file_start', { path: event.path })
  if (event.kind === 'chunk') {
    return encodeSseEvent('chunk', { path: event.path, text: event.text })
  }
  return encodeSseEvent('file_end', { path: event.path, bytes: event.bytes })
}

async function insertGeneration(input: StartGenerationInput): Promise<string> {
  const [row] = await db
    .insert(generations)
    .values({
      userId: input.userId,
      provider: input.selection.provider.id,
      model: input.selection.model,
      prompt: input.prompt,
      status: 'streaming',
      usedInstanceKey: input.selection.usedInstanceKey,
    })
    .returning({ id: generations.id })

  if (row === undefined) throw new HttpError('INTERNAL_ERROR', 'Could not start the generation')
  return row.id
}

/** Never throws: it runs from a catch block, and losing the reason would hide the real error. */
async function finishGeneration(
  generationId: string,
  fields: Partial<typeof generations.$inferInsert>,
): Promise<void> {
  try {
    await db
      .update(generations)
      .set({ ...fields, finishedAt: new Date() })
      .where(eq(generations.id, generationId))
  } catch (error) {
    console.error(
      JSON.stringify({ kind: 'generation.finish_failed', generationId, error: String(error) }),
    )
  }
}

function failureCodeOf(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return CLIENT_ABORTED
  return error instanceof HttpError ? error.code : 'INTERNAL_ERROR'
}

interface StreamContext {
  readonly input: StartGenerationInput
  readonly generationId: string
  readonly iterator: AsyncIterator<string>
  readonly first: IteratorResult<string>
  readonly usage: () => ProviderUsage
  readonly store: ObjectStore
}

async function persistArtifact(
  context: StreamContext,
  files: readonly { readonly path: string; readonly content: Buffer }[],
): Promise<{ readonly artifactId: string; readonly versionId: string; readonly viewUrl: string }> {
  const created = await createArtifactWithBundle(
    {
      ownerId: context.input.userId,
      title: titleFromPrompt(context.input.prompt),
      visibility: 'private',
      files,
      actorIp: context.input.actorIp ?? null,
    },
    context.store,
  )

  // §5.2 links the version back to the generation that produced it; `createArtifactWithBundle`
  // serves the upload path too, so the column is filled in here rather than passed through it.
  await db
    .update(artifactVersions)
    .set({ generationId: context.generationId })
    .where(eq(artifactVersions.id, created.versionId))

  return { artifactId: created.id, versionId: created.versionId, viewUrl: created.viewUrl }
}

async function pumpStream(
  context: StreamContext,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const parser = new FileBlockParser()

  for (let result = context.first; result.done !== true; result = await context.iterator.next()) {
    for (const event of parser.push(result.value)) controller.enqueue(sseFromParseEvent(event))
  }

  const created = await persistArtifact(context, parser.finish())
  const usage = context.usage()
  await finishGeneration(context.generationId, {
    status: 'succeeded',
    artifactId: created.artifactId,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  })

  controller.enqueue(encodeSseEvent('done', created))
}

/** A disconnected client cannot be told anything, so enqueueing after a cancel is not an error. */
function tryEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  frame: Uint8Array,
): void {
  try {
    controller.enqueue(frame)
  } catch {
    // The stream is already closed by the client.
  }
}

function buildEventStream(context: StreamContext): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await pumpStream(context, controller)
      } catch (error) {
        const code = failureCodeOf(error, context.input.signal)
        await finishGeneration(context.generationId, { status: 'failed', errorCode: code })

        if (code !== CLIENT_ABORTED) {
          const message =
            error instanceof HttpError ? error.message : 'The generation could not be completed'
          tryEnqueue(controller, encodeSseEvent('error', { code, message }))
        }
      } finally {
        controller.close()
        await context.iterator.return?.(undefined)
      }
    },
  })
}

/**
 * Records the attempt, opens the provider stream, and only then hands back a body. Throws an
 * `HttpError` for anything that fails before the first delta — that is what keeps
 * `PROVIDER_KEY_INVALID` a 400 and a provider 429 a 502 rather than a 200 with an error frame.
 */
export async function startGeneration(
  input: StartGenerationInput,
  store: ObjectStore = objectStore(),
): Promise<ReadableStream<Uint8Array>> {
  const generationId = await insertGeneration(input)

  let usage: ProviderUsage = { tokensIn: null, tokensOut: null }
  const iterator = input.selection.provider
    .generate({
      prompt: input.prompt,
      model: input.selection.model,
      apiKey: input.selection.apiKey,
      signal: input.signal,
      onUsage: (reported) => {
        usage = reported
      },
      ...(input.selection.baseUrl === undefined ? {} : { baseUrl: input.selection.baseUrl }),
    })
    [Symbol.asyncIterator]()

  try {
    const first = await iterator.next()
    return buildEventStream({
      input,
      generationId,
      iterator,
      first,
      usage: () => usage,
      store,
    })
  } catch (error) {
    await finishGeneration(generationId, {
      status: 'failed',
      errorCode: failureCodeOf(error, input.signal),
    })
    throw error instanceof HttpError
      ? error
      : new HttpError('INTERNAL_ERROR', 'The generation could not be started')
  }
}
