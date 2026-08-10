'use client'

import { useEffect, useState } from 'react'

import styles from './share-dialog.module.css'

/**
 * docs/motion.md, copy-link row: a 160 ms `scale(0.97)` press and an icon swap to a check. This is
 * the one place delight is earned, because copying the link is the product's core action.
 *
 * The press lives in CSS `:active` so it cannot desync from the pointer; only the icon swap needs
 * state, and it reverts on a timer so a second copy re-confirms rather than staying stuck.
 */

const CONFIRMATION_MS = 1600

export function CopyLinkButton({
  url,
  testId = 'share-copy',
}: {
  readonly url: string
  readonly testId?: string
}) {
  const [hasCopied, setHasCopied] = useState(false)

  useEffect(() => {
    if (!hasCopied) return undefined
    const timer = setTimeout(() => setHasCopied(false), CONFIRMATION_MS)
    return () => clearTimeout(timer)
  }, [hasCopied])

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setHasCopied(true)
    } catch {
      // A denied clipboard permission is not an error worth a banner — the URL is on screen and
      // selectable, so the user can still copy it by hand.
      setHasCopied(false)
    }
  }

  return (
    <button
      className={styles.copy}
      type="button"
      data-copied={hasCopied}
      data-testid={testId}
      onClick={() => void copy()}
    >
      {hasCopied ? <CheckIcon /> : <LinkIcon />}
      <span>{hasCopied ? 'Copied' : 'Copy link'}</span>
    </button>
  )
}

function LinkIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none">
      <path
        d="M6.5 9.5 9.5 6.5M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none">
      <path
        d="m3.5 8.5 3 3 6-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
