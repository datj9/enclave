import type { ShareLinkSummary } from '@/lib/shares/manage'

/**
 * The owner's share state for one artifact page, shared by the Share dialog, the privacy switch
 * and the Delete confirmation. One copy means a revoke in Share is at once what the other two warn
 * about — without each of them re-reading `/shares` every time it opens.
 *
 * `liveCount` is only ever taken from the server. It is counted in Postgres against its own
 * `now()` (an unrevoked link past its expiry is not live), which the client cannot reproduce
 * without trusting its own clock.
 */

export interface OwnerControlsState {
  readonly shares: readonly ShareLinkSummary[]
  readonly liveCount: number
  /** The newest list request whose answer has been applied; older answers are dropped. */
  readonly appliedRequestId: number
}

export type OwnerControlsAction =
  | {
      readonly type: 'sharesLoaded'
      /** Monotonic per page, issued when the request starts rather than when it lands. */
      readonly requestId: number
      readonly items: readonly ShareLinkSummary[]
      readonly liveCount: number
    }
  | {
      /**
       * A revoke the server just confirmed. Applied at once so the row stops offering Revoke even
       * if the follow-up list read fails. `liveCount` is left for that read to correct: a revoked
       * link that had already expired was never counted in the first place.
       */
      readonly type: 'shareRevoked'
      readonly shareId: string
      readonly revokedAt: string
    }

export function initialOwnerControlsState(
  shares: readonly ShareLinkSummary[],
  liveCount: number,
): OwnerControlsState {
  return { shares, liveCount, appliedRequestId: 0 }
}

export function ownerControlsReducer(
  state: OwnerControlsState,
  action: OwnerControlsAction,
): OwnerControlsState {
  switch (action.type) {
    case 'sharesLoaded':
      // Two reads in flight (a create, then a quick revoke) can land out of order; the one that
      // started last is the one that saw the most recent writes.
      if (action.requestId <= state.appliedRequestId) return state
      return {
        shares: action.items,
        liveCount: action.liveCount,
        appliedRequestId: action.requestId,
      }

    case 'shareRevoked': {
      let changed = false
      const shares = state.shares.map((share) => {
        if (share.shareId !== action.shareId || share.revokedAt !== null) return share
        changed = true
        return { ...share, revokedAt: action.revokedAt }
      })
      return changed ? { ...state, shares } : state
    }
  }
}
