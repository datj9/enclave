import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactProvider, ProviderSelection } from '@/lib/providers'
import type { ObjectStore } from '@/lib/storage/object-store'

/**
 * `startGeneration`'s side of the §5.7 contract, with the quota module and the driver stubbed:
 * the reservation happens before the provider is touched, a denial never reaches it, a call the
 * provider rejects before its first delta hands its daily unit back, and a call that streamed
 * keeps it. Also that the artifact version is created already linked to its generation.
 */

const mocks = vi.hoisted(() => ({
  reserveGeneration: vi.fn(),
  releaseGenerationReservation: vi.fn(() => Promise.resolve()),
  createArtifactWithBundle: vi.fn(() =>
    Promise.resolve({ id: 'artifact-1', versionId: 'version-1', viewUrl: '/a/artifact-1' }),
  ),
}))

vi.mock('@/lib/quota', () => ({
  reserveGeneration: mocks.reserveGeneration,
  releaseGenerationReservation: mocks.releaseGenerationReservation,
}))

vi.mock('@/lib/artifacts/create', () => ({
  createArtifactWithBundle: mocks.createArtifactWithBundle,
}))

/** Only `finishGeneration`'s `update().set().where()` reaches the pool in these paths. */
vi.mock('@/db', () => {
  const where = () => Promise.resolve()
  return { db: { update: () => ({ set: () => ({ where }) }) } }
})

const { HttpError } = await import('@/lib/http')
const { startGeneration } = await import('@/lib/generation/run')

const USER_ID = '7f3e0000-0000-4000-8000-0000000000bb'
const RESERVATION = { userId: USER_ID, windowDate: '2026-08-01' }
const WELL_FORMED = '<file path="index.html">\n<!doctype html><title>Hi</title>\n</file>\n'

const unusedStore = {} as ObjectStore

function providerThat(behaviour: () => AsyncGenerator<string>): {
  provider: ArtifactProvider
  calls: () => number
} {
  let calls = 0
  return {
    provider: {
      id: 'anthropic',
      generate: () => {
        calls += 1
        return behaviour()
      },
    },
    calls: () => calls,
  }
}

function selectionWith(provider: ArtifactProvider, usedInstanceKey: boolean): ProviderSelection {
  return { provider, model: 'stub-model', apiKey: 'sk-test', baseUrl: undefined, usedInstanceKey }
}

function start(provider: ArtifactProvider, usedInstanceKey = true) {
  return startGeneration(
    {
      userId: USER_ID,
      prompt: 'a countdown timer',
      selection: selectionWith(provider, usedInstanceKey),
      signal: new AbortController().signal,
    },
    unusedStore,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.reserveGeneration.mockImplementation(() =>
    Promise.resolve({ record: 'generation-1', reservation: RESERVATION }),
  )
})

describe('startGeneration · quota reservation', () => {
  it('reserves against the cap of whichever key runs', async () => {
    const { provider } = providerThat(async function* () {
      yield WELL_FORMED
    })

    await (await start(provider, false)).pipeTo(new WritableStream())
    await (await start(provider, true)).pipeTo(new WritableStream())

    expect(mocks.reserveGeneration.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [USER_ID, true],
      [USER_ID, false],
    ])
  })

  it('never calls the provider when the reservation is denied', async () => {
    const denial = new HttpError('RATE_LIMITED', 'Rate limit reached, retry in 60s')
    mocks.reserveGeneration.mockImplementation(() => Promise.reject(denial))
    const { provider, calls } = providerThat(async function* () {
      yield WELL_FORMED
    })

    await expect(start(provider)).rejects.toBe(denial)
    expect(calls()).toBe(0)
    expect(mocks.releaseGenerationReservation).not.toHaveBeenCalled()
  })

  it('refunds the daily unit when the provider rejects the call before any output', async () => {
    const rejected = new HttpError('PROVIDER_KEY_INVALID', 'The provider rejected the key')
    const { provider } = providerThat(async function* () {
      yield* []
      throw rejected
    })

    await expect(start(provider)).rejects.toBe(rejected)
    expect(mocks.releaseGenerationReservation).toHaveBeenCalledTimes(1)
    expect(mocks.releaseGenerationReservation).toHaveBeenCalledWith(RESERVATION)
  })

  it('keeps the unit once the provider has produced output, even if the stream fails later', async () => {
    const { provider } = providerThat(async function* () {
      yield '<file path="index.html">\n<!doctype html>'
      throw new Error('socket hang up')
    })

    const stream = await start(provider)
    const body = await new Response(stream).text()

    expect(body).toContain('event: error')
    expect(mocks.releaseGenerationReservation).not.toHaveBeenCalled()
  })

  it('creates the artifact already linked to the generation that produced it', async () => {
    const { provider } = providerThat(async function* () {
      yield WELL_FORMED
    })

    const body = await new Response(await start(provider)).text()

    expect(body).toContain('event: done')
    expect(mocks.createArtifactWithBundle).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: USER_ID, generationId: 'generation-1' }),
      unusedStore,
    )
  })
})
