import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClientModule from './src/api-client.ts'

import { ApiError } from './src/api-client.ts'
import {
  runList,
  runPrivacy,
  runRemove,
  runRename,
  runRestore,
  runShow,
} from './src/commands/artifacts.ts'

interface RecordedCall {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

/**
 * Hoisted so the `vi.mock` factory below can close over it: the factory runs before the imports.
 * Every command reaches the network through `apiClient`, so replacing it is the whole isolation.
 */
const harness = vi.hoisted(() => {
  const calls: { method: string; path: string; body: unknown }[] = []
  let responder: (call: { method: string; path: string; body: unknown }) => unknown = () => {
    throw new Error('the test set no responder')
  }

  return {
    calls,
    setResponder(next: (call: { method: string; path: string; body: unknown }) => unknown): void {
      responder = next
    },
    reset(): void {
      calls.length = 0
      responder = () => {
        throw new Error('the test set no responder')
      }
    },
    invoke(method: string, path: string, body: unknown): unknown {
      calls.push({ method, path, body })
      return responder({ method, path, body })
    },
  }
})

vi.mock('./src/api-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>()
  const client = {
    async get<T>(path: string): Promise<T> {
      return harness.invoke('GET', path, undefined) as T
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return harness.invoke('POST', path, body) as T
    },
    async patch<T>(path: string, body: unknown): Promise<T> {
      return harness.invoke('PATCH', path, body) as T
    },
    async remove(path: string): Promise<void> {
      harness.invoke('DELETE', path, undefined)
    },
  }
  return { ...actual, apiClient: () => client }
})

const HOST = 'enclave.example.com'
const FULL_ID = '3f2a91c4-7d1e-4a5b-9c3d-0e1f2a3b4c5d'
const OTHER_ID = '3f2a91c4-0000-4a5b-9c3d-9f8e7d6c5b4a'
const VIEW_URL = 'https://3f2a91c4.artifacts.example.com'

const KANBAN = {
  id: FULL_ID,
  title: 'Kanban board',
  slug: 'kanban-board',
  visibility: 'private',
  createdAt: '2026-08-02T14:31:09.221Z',
  updatedAt: '2026-08-02T14:31:09.221Z',
  viewUrl: VIEW_URL,
} as const

const PRICING = {
  id: '9c81ba07-2c44-4f9a-8b21-5d7e6f0a1b2c',
  title: 'Pricing mock',
  slug: 'pricing-mock',
  visibility: 'org',
  createdAt: '2026-08-01T09:02:44.010Z',
  updatedAt: '2026-08-01T09:02:44.010Z',
  viewUrl: 'https://9c81ba07.artifacts.example.com',
} as const

type StdoutWrite = typeof process.stdout.write

let written: string[] = []
let writtenToStderr: string[] = []
let configHome: string
let originalConfigHome: string | undefined
let originalToken: string | undefined

function output(): string {
  return written.join('')
}

/** Failures land on stderr so `--json` can promise stdout is nothing but the API object. */
function errorOutput(): string {
  return writtenToStderr.join('')
}

function callAt(index: number): RecordedCall {
  const call = harness.calls[index]
  if (call === undefined) {
    throw new Error(
      `expected a call at index ${String(index)}, saw ${String(harness.calls.length)}`,
    )
  }
  return call
}

function notFoundForEverything(): void {
  harness.setResponder(() => {
    throw new ApiError(404, 'NOT_FOUND', 'No such artifact')
  })
}

/** Routed by `"<METHOD> <path>"`, so every assertion about a path is also made by the fixture. */
function respondWith(routes: Readonly<Record<string, unknown>>): void {
  harness.setResponder((call) => {
    const key = `${call.method} ${call.path}`
    if (!(key in routes)) throw new ApiError(404, 'NOT_FOUND', 'No such artifact')
    return routes[key]
  })
}

beforeEach(() => {
  harness.reset()
  written = []
  writtenToStderr = []

  originalConfigHome = process.env['XDG_CONFIG_HOME']
  originalToken = process.env['ENCLAVE_TOKEN']
  configHome = mkdtempSync(join(tmpdir(), 'enclave-artifacts-'))
  process.env['XDG_CONFIG_HOME'] = configHome
  process.env['ENCLAVE_TOKEN'] = 'test-token'

  // The overload set on stdout.write cannot be expressed by a single implementation signature.
  const capture = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as StdoutWrite
  vi.spyOn(process.stdout, 'write').mockImplementation(capture)

  const captureStderr = ((chunk: string | Uint8Array): boolean => {
    writtenToStderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as StdoutWrite
  vi.spyOn(process.stderr, 'write').mockImplementation(captureStderr)
})

afterEach(() => {
  vi.restoreAllMocks()

  if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = originalConfigHome

  if (originalToken === undefined) delete process.env['ENCLAVE_TOKEN']
  else process.env['ENCLAVE_TOKEN'] = originalToken

  rmSync(configHome, { recursive: true, force: true })
})

describe('AC 1 — list paginates and consumes nextCursor', () => {
  it('walks every page when neither --limit nor --cursor is given', async () => {
    respondWith({
      'GET /api/v1/artifacts': { items: [KANBAN], nextCursor: 'cursor-1' },
      'GET /api/v1/artifacts?cursor=cursor-1': { items: [PRICING], nextCursor: null },
    })

    expect(await runList({ host: HOST, isJson: false })).toBe(0)

    expect(harness.calls).toHaveLength(2)
    expect(callAt(0)).toEqual({ method: 'GET', path: '/api/v1/artifacts', body: undefined })
    expect(callAt(1)).toEqual({
      method: 'GET',
      path: '/api/v1/artifacts?cursor=cursor-1',
      body: undefined,
    })
    expect(output()).toContain('Kanban board')
    expect(output()).toContain('Pricing mock')
  })

  it('exposes --cursor and requests exactly that page', async () => {
    respondWith({
      'GET /api/v1/artifacts?cursor=cursor-1': { items: [PRICING], nextCursor: null },
    })

    expect(await runList({ host: HOST, cursor: 'cursor-1', isJson: false })).toBe(0)

    expect(harness.calls).toHaveLength(1)
    expect(callAt(0).path).toBe('/api/v1/artifacts?cursor=cursor-1')
    expect(output()).toContain('Pricing mock')
    expect(output()).not.toContain('Kanban board')
  })

  it('prints how to reach the next page when --limit stops short of the end', async () => {
    respondWith({
      'GET /api/v1/artifacts?limit=1': { items: [KANBAN], nextCursor: 'cursor-1' },
    })

    expect(await runList({ host: HOST, limit: 1, isJson: false })).toBe(0)

    expect(harness.calls).toHaveLength(1)
    expect(callAt(0).path).toBe('/api/v1/artifacts?limit=1')
    expect(output()).toContain('enclave list --cursor cursor-1')
  })

  it('reports an empty account without inventing a page', async () => {
    respondWith({ 'GET /api/v1/artifacts': { items: [], nextCursor: null } })

    expect(await runList({ host: HOST, isJson: false })).toBe(0)
    expect(output()).toContain('no artifacts')
  })

  it('stops instead of looping forever when nextCursor never advances', async () => {
    harness.setResponder(() => ({ items: [], nextCursor: 'stuck-cursor' }))

    expect(await runList({ host: HOST, isJson: false })).toBe(1)
    expect(errorOutput()).toContain('did not terminate')
  })

  it('sanitizes control characters out of a title before it reaches the column layout', async () => {
    respondWith({
      'GET /api/v1/artifacts': {
        items: [{ ...KANBAN, title: 'evil\x1b[31mtitle' }],
        nextCursor: null,
      },
    })

    expect(await runList({ host: HOST, isJson: false })).toBe(0)
    expect(output()).not.toContain('\x1b')
    expect(output()).toContain('evil')
  })
})

describe('AC 2 — show', () => {
  it('prints id, title, visibility, created and viewUrl', async () => {
    respondWith({ [`GET /api/v1/artifacts/${FULL_ID}`]: KANBAN })

    expect(await runShow({ host: HOST, id: FULL_ID, isJson: false })).toBe(0)

    expect(harness.calls).toHaveLength(1)
    expect(callAt(0)).toEqual({
      method: 'GET',
      path: `/api/v1/artifacts/${FULL_ID}`,
      body: undefined,
    })
    expect(output()).toContain(FULL_ID)
    expect(output()).toContain('Kanban board')
    expect(output()).toContain('private')
    expect(output()).toContain('2026-08-02T14:31:09.221Z')
    expect(output()).toContain(VIEW_URL)
  })
})

describe('AC 3 — privacy org', () => {
  it('PATCHes {visibility:org} and prints the old → new value', async () => {
    respondWith({
      [`GET /api/v1/artifacts/${FULL_ID}`]: KANBAN,
      [`PATCH /api/v1/artifacts/${FULL_ID}`]: { ...KANBAN, visibility: 'org' },
    })

    expect(await runPrivacy({ host: HOST, id: FULL_ID, visibility: 'org' })).toBe(0)

    const patch = callAt(1)
    expect(patch.method).toBe('PATCH')
    expect(patch.path).toBe(`/api/v1/artifacts/${FULL_ID}`)
    expect(patch.body).toEqual({ visibility: 'org' })
    expect(output()).toContain('private → org')
    expect(output()).toContain('everyone on this instance can now read it')
  })

  it('PATCHes {visibility:private} and prints org → private', async () => {
    respondWith({
      [`GET /api/v1/artifacts/${PRICING.id}`]: PRICING,
      [`PATCH /api/v1/artifacts/${PRICING.id}`]: { ...PRICING, visibility: 'private' },
    })

    expect(await runPrivacy({ host: HOST, id: PRICING.id, visibility: 'private' })).toBe(0)

    expect(callAt(1).body).toEqual({ visibility: 'private' })
    expect(output()).toContain('org → private')
  })
})

describe('AC 4 — there is no public visibility', () => {
  it('privacy <id> public exits 2 before any HTTP call', async () => {
    expect(await runPrivacy({ host: HOST, id: FULL_ID, visibility: 'public' })).toBe(2)

    expect(harness.calls).toHaveLength(0)
    expect(errorOutput()).toContain('must be private or org')
    expect(errorOutput()).toContain('share link')
  })

  it('any other unknown visibility exits 2 before any HTTP call', async () => {
    expect(await runPrivacy({ host: HOST, id: FULL_ID, visibility: 'unlisted' })).toBe(2)

    expect(harness.calls).toHaveLength(0)
    expect(errorOutput()).toContain("not 'unlisted'")
  })
})

describe('AC 5 — rename sends the title only', () => {
  it('PATCHes exactly {title} and never visibility', async () => {
    respondWith({
      [`PATCH /api/v1/artifacts/${FULL_ID}`]: { ...KANBAN, title: 'Sprint board' },
    })

    expect(await runRename({ host: HOST, id: FULL_ID, title: 'Sprint board' })).toBe(0)

    expect(harness.calls).toHaveLength(1)
    const patch = callAt(0)
    expect(patch.method).toBe('PATCH')
    expect(patch.path).toBe(`/api/v1/artifacts/${FULL_ID}`)
    expect(patch.body).toEqual({ title: 'Sprint board' })
    expect(Object.keys(patch.body as Record<string, unknown>)).toEqual(['title'])
  })

  it('refuses a blank title with exit 2 and no HTTP call', async () => {
    expect(await runRename({ host: HOST, id: FULL_ID, title: '   ' })).toBe(2)

    expect(harness.calls).toHaveLength(0)
    expect(errorOutput()).toContain('a title is required')
  })
})

describe('AC 6 — rm hides the artifact, restore brings it back', () => {
  it('DELETEs, drops out of list, then POSTs restore and reappears', async () => {
    let isTrashed = false
    harness.setResponder((call) => {
      if (call.method === 'GET' && call.path === '/api/v1/artifacts') {
        return { items: isTrashed ? [] : [KANBAN], nextCursor: null }
      }
      if (call.method === 'DELETE' && call.path === `/api/v1/artifacts/${FULL_ID}`) {
        isTrashed = true
        return undefined
      }
      if (call.method === 'POST' && call.path === `/api/v1/artifacts/${FULL_ID}/restore`) {
        isTrashed = false
        return KANBAN
      }
      throw new ApiError(404, 'NOT_FOUND', 'No such artifact')
    })

    expect(await runList({ host: HOST, isJson: false })).toBe(0)
    expect(output()).toContain('Kanban board')

    written = []
    expect(await runRemove({ host: HOST, id: FULL_ID })).toBe(0)
    expect(callAt(1)).toEqual({
      method: 'DELETE',
      path: `/api/v1/artifacts/${FULL_ID}`,
      body: undefined,
    })
    expect(output()).toContain('to trash')

    written = []
    expect(await runList({ host: HOST, isJson: false })).toBe(0)
    expect(output()).not.toContain('Kanban board')
    expect(output()).toContain('no artifacts')

    written = []
    expect(await runRestore({ host: HOST, id: FULL_ID })).toBe(0)
    const restore = callAt(3)
    expect(restore.method).toBe('POST')
    expect(restore.path).toBe(`/api/v1/artifacts/${FULL_ID}/restore`)
    expect(restore.body).toBeUndefined()

    written = []
    expect(await runList({ host: HOST, isJson: false })).toBe(0)
    expect(output()).toContain('Kanban board')
  })
})

describe('AC 7 — a 404 reads as not found, never forbidden', () => {
  it('show says not found', async () => {
    notFoundForEverything()

    expect(await runShow({ host: HOST, id: FULL_ID, isJson: false })).toBe(1)
    expect(errorOutput()).toContain('not found')
    expect(output()).not.toContain('forbidden')
  })

  it('rm says not found', async () => {
    notFoundForEverything()

    expect(await runRemove({ host: HOST, id: FULL_ID })).toBe(1)
    expect(errorOutput()).toContain('not found')
    expect(output()).not.toContain('forbidden')
  })

  it('rename and privacy say not found', async () => {
    notFoundForEverything()

    expect(await runRename({ host: HOST, id: FULL_ID, title: 'Sprint board' })).toBe(1)
    expect(await runPrivacy({ host: HOST, id: FULL_ID, visibility: 'org' })).toBe(1)
    expect(await runRestore({ host: HOST, id: FULL_ID })).toBe(1)
    expect(output()).not.toContain('forbidden')
    expect(errorOutput().match(/not found/g)).toHaveLength(3)
  })
})

describe('AC 8 — an ambiguous prefix', () => {
  it('exits 1 and lists both candidates without reading either', async () => {
    respondWith({
      'GET /api/v1/artifacts': {
        items: [KANBAN, { ...PRICING, id: OTHER_ID, title: 'Kanban archive' }],
        nextCursor: null,
      },
    })

    expect(await runShow({ host: HOST, id: '3f2a91c4', isJson: false })).toBe(1)

    expect(harness.calls).toHaveLength(1)
    expect(callAt(0).path).toBe('/api/v1/artifacts')
    expect(errorOutput()).toContain('matches 2 artifacts')
    expect(errorOutput()).toContain('Kanban board')
    expect(errorOutput()).toContain('Kanban archive')
  })
})

describe('AC 9 — --json emits the raw API object and nothing else', () => {
  it('list --json emits one page object covering every page', async () => {
    respondWith({
      'GET /api/v1/artifacts': { items: [KANBAN], nextCursor: 'cursor-1' },
      'GET /api/v1/artifacts?cursor=cursor-1': { items: [PRICING], nextCursor: null },
    })

    expect(await runList({ host: HOST, isJson: true })).toBe(0)

    expect(JSON.parse(output())).toEqual({ items: [KANBAN, PRICING], nextCursor: null })
  })

  it('show --json emits the ArtifactView', async () => {
    respondWith({ [`GET /api/v1/artifacts/${FULL_ID}`]: KANBAN })

    expect(await runShow({ host: HOST, id: FULL_ID, isJson: true })).toBe(0)

    expect(JSON.parse(output())).toEqual(KANBAN)
  })

  it('rename --json emits the updated ArtifactView', async () => {
    const renamed = { ...KANBAN, title: 'Sprint board' }
    respondWith({ [`PATCH /api/v1/artifacts/${FULL_ID}`]: renamed })

    expect(await runRename({ host: HOST, id: FULL_ID, title: 'Sprint board', isJson: true })).toBe(
      0,
    )

    expect(JSON.parse(output())).toEqual(renamed)
  })

  it('privacy --json emits the updated ArtifactView', async () => {
    const shared = { ...KANBAN, visibility: 'org' }
    respondWith({
      [`GET /api/v1/artifacts/${FULL_ID}`]: KANBAN,
      [`PATCH /api/v1/artifacts/${FULL_ID}`]: shared,
    })

    expect(await runPrivacy({ host: HOST, id: FULL_ID, visibility: 'org', isJson: true })).toBe(0)

    expect(JSON.parse(output())).toEqual(shared)
  })

  it('rm --json emits the deletion, the one call with no response body', async () => {
    harness.setResponder(() => undefined)

    expect(await runRemove({ host: HOST, id: FULL_ID, isJson: true })).toBe(0)

    expect(JSON.parse(output())).toEqual({ id: FULL_ID, deleted: true })
  })

  it('restore --json emits the restored ArtifactView', async () => {
    respondWith({ [`POST /api/v1/artifacts/${FULL_ID}/restore`]: KANBAN })

    expect(await runRestore({ host: HOST, id: FULL_ID, isJson: true })).toBe(0)

    expect(JSON.parse(output())).toEqual(KANBAN)
  })
})

describe('credentials', () => {
  it('exits 1 without an HTTP call when no token is stored for the host', async () => {
    delete process.env['ENCLAVE_TOKEN']

    expect(await runList({ host: HOST, isJson: false })).toBe(1)

    expect(harness.calls).toHaveLength(0)
    expect(errorOutput()).toContain('not logged in to enclave.example.com')
  })
})

/**
 * The rule `--json` promises: stdout carries the API object and nothing else. A human-readable
 * error printed there turns `enclave show … --json | jq` into a parse error rather than a
 * diagnosable failure, so every failure path must leave stdout empty or valid JSON.
 */
describe('--json keeps stdout machine-readable on failure', () => {
  // respondWith 404s any key it was not given, which is exactly the missing-artifact case.

  it('show prints nothing to stdout when the artifact is missing', async () => {
    respondWith({})

    const code = await runShow({
      host: 'enclave.example.com',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      isJson: true,
    })

    expect(code).toBe(1)
    expect(written.join('')).toBe('')
    expect(writtenToStderr.join('')).toContain('not found')
  })

  it('rm prints nothing to stdout when the artifact is missing', async () => {
    respondWith({})

    const code = await runRemove({
      host: 'enclave.example.com',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      isJson: true,
    })

    expect(code).toBe(1)
    expect(written.join('')).toBe('')
  })

  it('anything stdout does emit under --json parses as JSON', async () => {
    respondWith({})

    await runShow({
      host: 'enclave.example.com',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      isJson: true,
    })

    const stdout = written.join('').trim()
    if (stdout !== '') expect(() => JSON.parse(stdout) as unknown).not.toThrow()
  })
})
