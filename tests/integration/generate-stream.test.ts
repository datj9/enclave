import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import { artifactVersions, artifacts } from '@/db/schema/artifacts'
import { auditLog } from '@/db/schema/audit-log'
import { users } from '@/db/schema/users'
import { generations } from '@/db/schema/generations'
import { listOwnedArtifacts } from '@/lib/artifacts/list'
import { DEFAULT_LIST_LIMIT } from '@/lib/artifacts/list-query'
import { HttpError } from '@/lib/http'
import type * as ProvidersModule from '@/lib/providers'
import type { ArtifactProvider, ProviderSelection } from '@/lib/providers'
import type * as S3Module from '@/lib/storage/s3'
import type { ObjectStore } from '@/lib/storage/object-store'
import { createTestStore, probeServices, removeTestOwnerData } from './services'

/**
 * The whole S6 route against real Postgres and real object storage, with the model replaced by a
 * stub. No API key, no network to a provider: every delta in this file is a literal string.
 *
 * What a unit test cannot prove and this does: the §5.4 event order over a real `Response` body,
 * that a completed stream leaves exactly one artifact and one `ready` version, and that an abort
 * leaves nothing readable behind.
 */

const { database, storage } = await probeServices()
const servicesReady = database && storage

if (!servicesReady) {
  console.warn(
    `[enclave] skipping tests/integration: database=${database} storage=${storage}. ` +
      'Start them with `docker compose --profile minio up -d` and run `pnpm db:migrate`.',
  )
}

const INDEX_HTML = '<!doctype html><title>Countdown</title><script src=app.js></script>'
const APP_JS = 'setInterval(() => document.title, 1000)'

const WELL_FORMED = [
  `<file path="index.html">\n${INDEX_HTML}\n</file>\n`,
  `<file path="app.js">\n${APP_JS}\n</file>\n`,
]

const TOKENS_IN = 42
const TOKENS_OUT = 512

const mocks = vi.hoisted(() => ({
  sessionUser: null as { id: string; email: string; role: string; isActive: boolean } | null,
  deltas: [] as string[],
  failWith: undefined as unknown,
  selection: undefined as unknown,
  store: undefined as ObjectStore | undefined,
  abortAfterDelta: undefined as number | undefined,
  controller: undefined as AbortController | undefined,
}))

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: () => Promise.resolve(mocks.sessionUser),
}))

vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof ProvidersModule>()
  return {
    ...actual,
    resolveProviderForUser: () => {
      if (mocks.selection === undefined) throw new HttpError('PROVIDER_KEY_INVALID', 'no key')
      return mocks.selection as ProviderSelection
    },
  }
})

vi.mock('@/lib/storage/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof S3Module>()
  return { ...actual, objectStore: () => mocks.store ?? actual.objectStore() }
})

const { POST } = await import('@app/api/v1/generate/route')

/** Emits the queued deltas, then whatever failure the test asked for. */
const stubProvider: ArtifactProvider = {
  id: 'anthropic',
  async *generate(input) {
    for (const [index, delta] of mocks.deltas.entries()) {
      if (input.signal.aborted) throw new Error('aborted')
      yield delta
      if (mocks.abortAfterDelta === index) {
        mocks.controller?.abort()
        throw new Error('aborted')
      }
    }
    if (mocks.failWith !== undefined) throw mocks.failWith
    input.onUsage?.({ tokensIn: TOKENS_IN, tokensOut: TOKENS_OUT })
  },
}

function selectionWith(overrides: Partial<ProviderSelection> = {}): ProviderSelection {
  return {
    provider: stubProvider,
    apiKey: 'stub-key',
    model: 'stub-model',
    baseUrl: undefined,
    usedInstanceKey: true,
    ...overrides,
  }
}

function generateRequest(body: unknown, signal?: AbortSignal): Request {
  return new Request('http://localhost:3000/api/v1/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
}

interface SseFrame {
  readonly event: string
  readonly data: Record<string, unknown>
}

async function readFrames(response: Response): Promise<SseFrame[]> {
  const body = await response.text()
  return body
    .split('\n\n')
    .filter((frame) => frame.trim() !== '')
    .map((frame) => {
      const [eventLine = '', dataLine = ''] = frame.split('\n')
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')) as Record<string, unknown>,
      }
    })
}

/**
 * Its own owner, not `createTestOwner`'s shared one: vitest runs test files in parallel and that
 * helper deletes by a single fixed email, so two suites would tear down each other's rows.
 */
const OWNER_EMAIL = 'integration-generate@example.test'

async function createGenerationOwner(): Promise<string> {
  const [owner] = await db
    .insert(users)
    .values({ email: OWNER_EMAIL, passwordHash: null, role: 'member', isActive: true })
    .returning({ id: users.id })

  if (owner === undefined) throw new Error('could not create the generation test owner')
  return owner.id
}

async function generationRowsFor(userId: string) {
  return db.select().from(generations).where(eq(generations.userId, userId))
}

describe.skipIf(!servicesReady)('POST /api/v1/generate', () => {
  let ownerId = ''
  let store: ObjectStore

  beforeAll(async () => {
    store = createTestStore()
    await store.ensureBucket()
  })

  beforeEach(async () => {
    if (ownerId !== '') await cleanUp()
    ownerId = await createGenerationOwner()
    mocks.sessionUser = { id: ownerId, email: OWNER_EMAIL, role: 'member', isActive: true }
    mocks.deltas = [...WELL_FORMED]
    mocks.failWith = undefined
    mocks.selection = selectionWith()
    mocks.store = undefined
    mocks.abortAfterDelta = undefined
    mocks.controller = undefined
  })

  afterAll(async () => {
    if (ownerId !== '') await cleanUp()
  })

  async function cleanUp(): Promise<void> {
    await db.delete(generations).where(eq(generations.userId, ownerId))
    await removeTestOwnerData(ownerId, store)
  }

  it('streams the §5.4 events in order and ends with a resolvable viewUrl', async () => {
    const response = await POST(generateRequest({ prompt: 'a countdown timer to new year' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')

    const frames = await readFrames(response)
    expect(frames.map((frame) => frame.event).filter((event) => event !== 'chunk')).toEqual([
      'file_start',
      'file_end',
      'file_start',
      'file_end',
      'done',
    ])

    expect(frames[0]).toEqual({ event: 'file_start', data: { path: 'index.html' } })
    const fileEnds = frames.filter((frame) => frame.event === 'file_end')
    expect(fileEnds[0]?.data).toEqual({
      path: 'index.html',
      bytes: Buffer.byteLength(INDEX_HTML, 'utf8'),
    })
    expect(fileEnds[1]?.data).toEqual({ path: 'app.js', bytes: Buffer.byteLength(APP_JS, 'utf8') })

    const chunked = frames
      .filter((frame) => frame.event === 'chunk' && frame.data.path === 'index.html')
      .map((frame) => frame.data.text)
      .join('')
    expect(chunked).toBe(INDEX_HTML)

    const done = frames.at(-1)
    expect(done?.event).toBe('done')
    expect(String(done?.data.viewUrl)).toContain(String(done?.data.artifactId))
  })

  it('leaves exactly one artifact and one ready version behind', async () => {
    const frames = await readFrames(await POST(generateRequest({ prompt: 'a countdown timer' })))
    const done = frames.at(-1)?.data ?? {}

    const rows = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(done.artifactId)
    expect(rows[0]?.currentVersionId).toBe(done.versionId)
    expect(rows[0]?.visibility).toBe('private')

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, String(done.artifactId)))
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      status: 'ready',
      versionNo: 1,
      fileCount: 2,
      totalBytes: Buffer.byteLength(INDEX_HTML, 'utf8') + Buffer.byteLength(APP_JS, 'utf8'),
    })

    const [generation] = await generationRowsFor(ownerId)
    expect(generation).toMatchObject({
      status: 'succeeded',
      artifactId: done.artifactId,
      provider: 'anthropic',
      tokensIn: TOKENS_IN,
      tokensOut: TOKENS_OUT,
      usedInstanceKey: true,
      errorCode: null,
    })
    expect(versions[0]?.generationId).toBe(generation?.id)
    expect(generation?.finishedAt).not.toBeNull()
  })

  it('stores the objects so the viewer can serve them', async () => {
    const frames = await readFrames(await POST(generateRequest({ prompt: 'a countdown timer' })))
    const done = frames.at(-1)?.data ?? {}
    const key = `artifacts/${String(done.artifactId)}/${String(done.versionId)}/index.html`

    const object = await store.getObject(key)
    expect(object?.body.toString('utf8')).toBe(INDEX_HTML)
    expect(object?.contentType).toBe('text/html')
  })

  it('rejects an unauthenticated caller before touching the provider', async () => {
    mocks.sessionUser = null

    const response = await POST(generateRequest({ prompt: 'anything' }))

    expect(response.status).toBe(401)
    expect(await generationRowsFor(ownerId)).toHaveLength(0)
  })

  it('rejects an empty prompt without recording an attempt', async () => {
    const response = await POST(generateRequest({ prompt: '   ' }))

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    })
    expect(await generationRowsFor(ownerId)).toHaveLength(0)
  })

  it('returns 400 PROVIDER_KEY_INVALID and writes no rows when no key is configured', async () => {
    mocks.selection = undefined

    const response = await POST(generateRequest({ prompt: 'a countdown timer' }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_KEY_INVALID' },
    })
    expect(await generationRowsFor(ownerId)).toHaveLength(0)
    expect(await db.select().from(artifacts).where(eq(artifacts.ownerId, ownerId))).toHaveLength(0)
  })

  it('surfaces a provider 429 as 502 PROVIDER_RATE_LIMITED and does not retry', async () => {
    mocks.deltas = []
    mocks.failWith = new HttpError('PROVIDER_RATE_LIMITED', 'The model provider is rate-limiting')

    const response = await POST(generateRequest({ prompt: 'a countdown timer' }))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PROVIDER_RATE_LIMITED' },
    })
    const [generation] = await generationRowsFor(ownerId)
    expect(generation).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_RATE_LIMITED' })
  })

  it('surfaces a refusal as 422 PROVIDER_REFUSED with the model message', async () => {
    mocks.deltas = []
    mocks.failWith = new HttpError('PROVIDER_REFUSED', 'I cannot build that.')

    const response = await POST(generateRequest({ prompt: 'something disallowed' }))

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      error: { code: 'PROVIDER_REFUSED', message: 'I cannot build that.' },
    })
  })

  it('persists nothing when the model writes prose before the first block', async () => {
    mocks.deltas = ['Sure! Here is your artifact:\n', ...WELL_FORMED]

    const frames = await readFrames(await POST(generateRequest({ prompt: 'a countdown timer' })))

    expect(frames).toEqual([
      {
        event: 'error',
        data: {
          code: 'MALFORMED_MODEL_OUTPUT',
          message: 'The model did not return a valid artifact',
        },
      },
    ])
    expect(await db.select().from(artifacts).where(eq(artifacts.ownerId, ownerId))).toHaveLength(0)
    expect((await generationRowsFor(ownerId))[0]).toMatchObject({
      status: 'failed',
      errorCode: 'MALFORMED_MODEL_OUTPUT',
      artifactId: null,
    })
  })

  it('persists nothing when the model never closes the final block', async () => {
    mocks.deltas = [WELL_FORMED[0] ?? '', `<file path="app.js">\n${APP_JS}`]

    const frames = await readFrames(await POST(generateRequest({ prompt: 'a countdown timer' })))

    expect(frames.filter((frame) => frame.event === 'done')).toHaveLength(0)
    expect(frames.at(-1)).toMatchObject({
      event: 'error',
      data: { code: 'MALFORMED_MODEL_OUTPUT' },
    })
    expect(await db.select().from(artifacts).where(eq(artifacts.ownerId, ownerId))).toHaveLength(0)
    expect((await generationRowsFor(ownerId))[0]).toMatchObject({ status: 'failed' })
  })

  it('records a mid-stream disconnect as a failed generation and persists nothing', async () => {
    const controller = new AbortController()
    mocks.controller = controller
    mocks.abortAfterDelta = 0

    const frames = await readFrames(
      await POST(generateRequest({ prompt: 'a countdown timer' }, controller.signal)),
    )

    expect(frames.filter((frame) => frame.event === 'done')).toHaveLength(0)
    expect(frames.filter((frame) => frame.event === 'error')).toHaveLength(0)
    expect((await generationRowsFor(ownerId))[0]).toMatchObject({
      status: 'failed',
      errorCode: 'CLIENT_ABORTED',
      artifactId: null,
    })
    expect(await db.select().from(artifacts).where(eq(artifacts.ownerId, ownerId))).toHaveLength(0)
  })

  it('leaves the version pending and invisible when the disconnect lands during the write', async () => {
    const controller = new AbortController()
    mocks.controller = controller
    // The only window in which a version row exists: the manifest is known, the objects are not
    // all uploaded yet. A disconnect here is what leaves a `pending` row for the sweeper.
    mocks.store = {
      ...store,
      putObject: () => {
        controller.abort()
        return Promise.reject(new Error('aborted'))
      },
    }

    await readFrames(await POST(generateRequest({ prompt: 'a countdown timer' }, controller.signal)))

    const [artifact] = await db.select().from(artifacts).where(eq(artifacts.ownerId, ownerId))
    expect(artifact?.currentVersionId).toBeNull()

    const versions = await db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.artifactId, String(artifact?.id)),
          eq(artifactVersions.status, 'pending'),
        ),
      )
    expect(versions).toHaveLength(1)

    const page = await listOwnedArtifacts(ownerId, { limit: DEFAULT_LIST_LIMIT, cursor: undefined })
    expect(page.items).toHaveLength(0)

    expect((await generationRowsFor(ownerId))[0]).toMatchObject({
      status: 'failed',
      errorCode: 'CLIENT_ABORTED',
    })
  })

  it('never writes the prompt anywhere but the generations row', async () => {
    const prompt = 'a countdown timer with my secret plan inside'
    const logged: string[] = []
    const info = vi.spyOn(console, 'info').mockImplementation((line: unknown) => {
      logged.push(String(line))
    })

    await readFrames(await POST(generateRequest({ prompt })))
    info.mockRestore()

    expect(logged.some((line) => line.includes('secret plan'))).toBe(false)
    expect((await generationRowsFor(ownerId))[0]?.prompt).toBe(prompt)

    // S4 moved the audit trail from stdout to `audit_log`; the prompt must not follow it there.
    const auditRows = await db
      .select({ action: auditLog.action, metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, ownerId))

    expect(auditRows.map((row) => row.action)).toContain('artifact.create')
    expect(JSON.stringify(auditRows)).not.toContain('secret plan')
  })
})
