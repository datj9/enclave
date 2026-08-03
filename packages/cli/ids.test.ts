import { describe, expect, it } from 'vitest'

import type { ApiClient } from './src/api-client.ts'
import { IdResolutionError, resolveArtifactId } from './src/ids.ts'

interface Page {
  readonly items: readonly { readonly id: string; readonly title: string }[]
  readonly nextCursor: string | null
}

function clientFromPages(pages: readonly Page[]): ApiClient {
  let call = 0
  return {
    async get<T>(): Promise<T> {
      const page = pages[Math.min(call, pages.length - 1)]
      call += 1
      return page as unknown as T
    },
    async post<T>(): Promise<T> {
      throw new Error('not used')
    },
    async patch<T>(): Promise<T> {
      throw new Error('not used')
    },
    async remove(): Promise<void> {
      throw new Error('not used')
    },
  }
}

const FULL_ID = '3F2A91C4-7D1E-4A5B-9C3D-0E1F2A3B4C5D'

describe('resolveArtifactId', () => {
  it('lowercases a full uuid without a network call', async () => {
    const client = clientFromPages([])

    expect(await resolveArtifactId(client, FULL_ID)).toBe(FULL_ID.toLowerCase())
  })

  it('resolves a prefix by walking every page', async () => {
    const client = clientFromPages([
      { items: [{ id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'a' }], nextCursor: 'c1' },
      { items: [{ id: 'bbbbbbbb-0000-4000-8000-000000000000', title: 'b' }], nextCursor: null },
    ])

    expect(await resolveArtifactId(client, 'bbbbbbbb')).toBe('bbbbbbbb-0000-4000-8000-000000000000')
  })

  it('throws instead of looping forever when the cursor never advances', async () => {
    const client = clientFromPages([{ items: [], nextCursor: 'stuck' }])

    await expect(resolveArtifactId(client, 'deadbeef')).rejects.toThrow(IdResolutionError)
  })
})
