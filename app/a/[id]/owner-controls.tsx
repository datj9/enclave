'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'

import type { ShareLinkSummary } from '@/lib/shares/manage'
import {
  initialOwnerControlsState,
  ownerControlsReducer,
  type OwnerControlsState,
} from './owner-controls-state'

/**
 * Seeded once by `page.tsx` from the same queries that render the page, then kept current by the
 * Share dialog's own writes. The privacy switch and the Delete confirmation read the live count
 * from here instead of fetching `/shares` each time they open.
 *
 * What this does not see: a link created or revoked from another tab or the CLI while this page
 * is open. The count can then be stale until a reload — which errs toward warning about a link
 * that is already gone, never toward staying silent about one that still opens.
 */

interface ListResponse {
  readonly data: { readonly items: readonly ShareLinkSummary[]; readonly liveCount: number }
}

interface OwnerControlsValue extends Pick<OwnerControlsState, 'shares' | 'liveCount'> {
  /** Re-reads the list after a write. A failed read keeps the last good state. */
  readonly refreshShares: () => Promise<void>
  /** Marks one link revoked locally, the moment the server has confirmed it. */
  readonly markRevoked: (shareId: string) => void
}

const OwnerControlsContext = createContext<OwnerControlsValue | null>(null)

export function OwnerControlsProvider({
  artifactId,
  initialShares,
  initialLiveCount,
  children,
}: {
  readonly artifactId: string
  readonly initialShares: readonly ShareLinkSummary[]
  readonly initialLiveCount: number
  readonly children: ReactNode
}) {
  const [state, dispatch] = useReducer(ownerControlsReducer, undefined, () =>
    initialOwnerControlsState(initialShares, initialLiveCount),
  )
  const nextRequestId = useRef(0)

  const refreshShares = useCallback(async (): Promise<void> => {
    nextRequestId.current += 1
    const requestId = nextRequestId.current
    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}/shares`)
      if (!response.ok) return
      const body = (await response.json()) as ListResponse
      dispatch({
        type: 'sharesLoaded',
        requestId,
        items: body.data.items,
        liveCount: body.data.liveCount,
      })
    } catch {
      // The write this follows already succeeded; a stale list is better than an error for it.
    }
  }, [artifactId])

  const markRevoked = useCallback((shareId: string): void => {
    dispatch({ type: 'shareRevoked', shareId, revokedAt: new Date().toISOString() })
  }, [])

  const value = useMemo<OwnerControlsValue>(
    () => ({ shares: state.shares, liveCount: state.liveCount, refreshShares, markRevoked }),
    [state.shares, state.liveCount, refreshShares, markRevoked],
  )

  return <OwnerControlsContext.Provider value={value}>{children}</OwnerControlsContext.Provider>
}

export function useOwnerControls(): OwnerControlsValue {
  const value = useContext(OwnerControlsContext)
  if (value === null) {
    throw new Error('useOwnerControls must be used inside <OwnerControlsProvider>')
  }
  return value
}
