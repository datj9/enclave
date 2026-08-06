'use client'

import { useState } from 'react'

import type { Visibility } from '@/db/schema/artifacts'
import styles from './privacy-switch.module.css'

/**
 * The owner's privacy control. Motion is a colour + `clip-path` crossfade over 180 ms with no
 * layout shift — docs/motion.md § This project's surfaces. The three options are equal width, so
 * the filled layer slides by re-clipping rather than by resizing anything.
 *
 * These are the three levels that are properties of the artifact. "Anyone with the link" is not
 * one of them: it is a capability derived from an active `share_links` row (§5.1 branch 4), so it
 * lives in the Share dialog next to this control rather than as a fourth segment here.
 */

interface PrivacyOption {
  readonly value: Visibility
  readonly label: string
  readonly hint: string
}

const OPTIONS: readonly PrivacyOption[] = [
  { value: 'private', label: 'Only me', hint: 'Nobody else can open it, not even an admin.' },
  { value: 'org', label: 'Organization', hint: 'Everyone signed in to this instance can open it.' },
  {
    value: 'public',
    label: 'Public',
    hint: 'Anyone with the address can open it, no sign-in — and search engines may index it.',
  },
]

const SAVE_FAILED = 'That change did not save. The artifact is still set to its previous level.'

function clipForIndex(activeIndex: number): string {
  const step = 100 / OPTIONS.length
  return `inset(0 ${(OPTIONS.length - 1 - activeIndex) * step}% 0 ${activeIndex * step}%)`
}

export function PrivacySwitch({
  artifactId,
  initialVisibility,
}: {
  readonly artifactId: string
  readonly initialVisibility: Visibility
}) {
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility)
  const [isSaving, setIsSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function choose(next: Visibility): Promise<void> {
    if (next === visibility || isSaving) return

    const previous = visibility
    // Optimistic: the crossfade is feedback for the click, so it must not wait on the network.
    setVisibility(next)
    setIsSaving(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      })
      if (!response.ok) {
        setVisibility(previous)
        setErrorMessage(SAVE_FAILED)
      }
    } catch {
      setVisibility(previous)
      setErrorMessage(SAVE_FAILED)
    } finally {
      setIsSaving(false)
    }
  }

  const activeIndex = OPTIONS.findIndex((option) => option.value === visibility)

  return (
    <div className={styles.wrapper}>
      <div className={styles.track} role="radiogroup" aria-label="Who can open this artifact">
        <span
          className={styles.fill}
          style={{ clipPath: clipForIndex(activeIndex) }}
          aria-hidden="true"
        />
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            className={styles.option}
            type="button"
            role="radio"
            aria-checked={option.value === visibility}
            aria-describedby={`privacy-hint-${option.value}`}
            disabled={isSaving}
            onClick={() => {
              void choose(option.value)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      {OPTIONS.map((option) => (
        <p
          key={option.value}
          className={styles.hint}
          id={`privacy-hint-${option.value}`}
          hidden={option.value !== visibility}
        >
          {option.hint}
        </p>
      ))}

      {errorMessage !== null && (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  )
}
