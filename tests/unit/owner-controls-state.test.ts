import { describe, expect, it } from 'vitest'

import {
  initialOwnerControlsState,
  ownerControlsReducer,
  type OwnerControlsState,
} from '@app/a/[id]/owner-controls-state'
import type { ShareLinkSummary } from '@/lib/shares/manage'

/**
 * The one copy of the owner's share state on an artifact page. The Share dialog writes it; the
 * privacy switch and the Delete confirmation only read `liveCount`, so the rules that matter are
 * that a stale list read never overwrites a newer one, and that a local revoke never guesses the
 * count.
 */

function share(overrides: Partial<ShareLinkSummary> = {}): ShareLinkSummary {
  return {
    shareId: 'share-1',
    versionId: 'version-1',
    expiresAt: null,
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('initialOwnerControlsState', () => {
  it('seeds from the server render with no request applied yet', () => {
    const shares = [share()]
    expect(initialOwnerControlsState(shares, 1)).toEqual({
      shares,
      liveCount: 1,
      appliedRequestId: 0,
    })
  })
})

describe('ownerControlsReducer — sharesLoaded', () => {
  const seeded = initialOwnerControlsState([share()], 1)

  it('replaces the list and the count with the server answer', () => {
    const items = [share({ shareId: 'share-2' }), share()]
    const next = ownerControlsReducer(seeded, {
      type: 'sharesLoaded',
      requestId: 1,
      items,
      liveCount: 2,
    })

    expect(next).toEqual({ shares: items, liveCount: 2, appliedRequestId: 1 })
  })

  it('drops an answer from a request that started before the one already applied', () => {
    const newer = ownerControlsReducer(seeded, {
      type: 'sharesLoaded',
      requestId: 2,
      items: [],
      liveCount: 0,
    })
    const afterStale = ownerControlsReducer(newer, {
      type: 'sharesLoaded',
      requestId: 1,
      items: [share()],
      liveCount: 1,
    })

    expect(afterStale).toBe(newer)
  })

  it('drops a repeat of the request already applied', () => {
    const applied = ownerControlsReducer(seeded, {
      type: 'sharesLoaded',
      requestId: 1,
      items: [],
      liveCount: 0,
    })

    expect(
      ownerControlsReducer(applied, {
        type: 'sharesLoaded',
        requestId: 1,
        items: [],
        liveCount: 0,
      }),
    ).toBe(applied)
  })
})

describe('ownerControlsReducer — shareRevoked', () => {
  const REVOKED_AT = '2026-09-23T10:00:00.000Z'

  it('marks the one link revoked and leaves the count for the server read to correct', () => {
    const state: OwnerControlsState = initialOwnerControlsState(
      [share({ shareId: 'a' }), share({ shareId: 'b' })],
      2,
    )
    const next = ownerControlsReducer(state, {
      type: 'shareRevoked',
      shareId: 'b',
      revokedAt: REVOKED_AT,
    })

    expect(next.shares.map((row) => row.revokedAt)).toEqual([null, REVOKED_AT])
    // An expired-but-unrevoked link was never live; decrementing here would undercount it.
    expect(next.liveCount).toBe(2)
    expect(next.appliedRequestId).toBe(0)
  })

  it('keeps the original revoke time of a link that was already revoked', () => {
    const earlier = '2026-09-01T00:00:00.000Z'
    const state = initialOwnerControlsState([share({ revokedAt: earlier })], 0)

    expect(
      ownerControlsReducer(state, {
        type: 'shareRevoked',
        shareId: 'share-1',
        revokedAt: REVOKED_AT,
      }),
    ).toBe(state)
  })

  it('returns the same state for an unknown link', () => {
    const state = initialOwnerControlsState([share()], 1)

    expect(
      ownerControlsReducer(state, { type: 'shareRevoked', shareId: 'nope', revokedAt: REVOKED_AT }),
    ).toBe(state)
  })
})
