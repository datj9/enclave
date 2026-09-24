'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { privateConfirmBody, privateHint } from '@/lib/artifacts/privacy-copy'
import type { Visibility } from '@/db/schema/artifacts'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import { useOwnerControls } from './owner-controls'
import styles from './privacy-switch.module.css'
import { radioFocusTarget } from './radio-keys'

/**
 * The owner's privacy control. Motion is a colour + `clip-path` crossfade over 180 ms with no
 * layout shift — docs/motion.md § This project's surfaces. The three options are equal width, so
 * the filled layer slides by re-clipping rather than by resizing anything.
 *
 * These are the three levels that are properties of the artifact. "Anyone with the link" is not
 * one of them: it is a capability derived from an active `share_links` row (§5.1 branch 4), so it
 * lives in the Share dialog next to this control rather than as a fourth segment here.
 *
 * Two levels confirm before they commit. `public` always does: it is the one transition that hands
 * the artifact to the whole internet. `private` does only when live links remain, because the
 * downgrade does not close them — and asking about links that do not exist would be noise.
 *
 * Keyboard: manual activation (radio-keys.ts). Arrows move focus only; Space or Enter commits the
 * focused level. A save is announced once, politely, as "Saved" — the crossfade alone is not
 * something a screen reader can hear.
 */

interface PrivacyOption {
  readonly value: Visibility
  readonly label: string
}

const OPTIONS: readonly PrivacyOption[] = [
  { value: 'private', label: 'Only me' },
  { value: 'org', label: 'Organization' },
  { value: 'public', label: 'Public' },
]

const FIXED_HINTS: Readonly<Record<Exclude<Visibility, 'private'>, string>> = {
  org: 'Everyone signed in to this instance can open it.',
  public: 'Anyone with the address can open it, no sign-in — and search engines may index it.',
}

/** Only `private` varies: its hint has to name the links the downgrade will leave open. */
function hintFor(visibility: Visibility, liveShareLinkCount: number): string {
  return visibility === 'private' ? privateHint(liveShareLinkCount) : FIXED_HINTS[visibility]
}

const SAVE_FAILED = 'That change did not save. The artifact is still set to its previous level.'

const PUBLISH_WARNING =
  "Anyone can open this at its address with no account and no link. Search engines are allowed to index it, and it will appear in this instance's sitemap. You can set it back to Only me at any time — the page stops opening immediately, and leaves the index when the crawler next comes round."

/** Long enough to be read; short enough that a stale "Saved" never sits beside a later change. */
const SAVED_NOTICE_MS = 2500

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
  // Shared with the Share dialog on this page, so a revoke there is already reflected here.
  const { liveCount: liveShareLinks } = useOwnerControls()
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility)
  const [isSaving, setIsSaving] = useState(false)
  const [savedNotice, setSavedNotice] = useState('')
  const [isConfirmingPublic, setIsConfirmingPublic] = useState(false)
  const [isConfirmingPrivate, setIsConfirmingPrivate] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([])
  const publicOptionRef = useRef<HTMLButtonElement | null>(null)
  const privateOptionRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (savedNotice === '') return undefined
    const timer = setTimeout(() => setSavedNotice(''), SAVED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [savedNotice])

  async function choose(next: Visibility): Promise<void> {
    if (next === visibility || isSaving) return

    const previous = visibility
    // Optimistic: the crossfade is feedback for the click, so it must not wait on the network.
    setVisibility(next)
    setIsSaving(true)
    setErrorMessage(null)
    setSavedNotice('')

    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: next }),
      })
      if (!response.ok) {
        setVisibility(previous)
        setErrorMessage(SAVE_FAILED)
        return
      }
      setSavedNotice('Saved')
    } catch {
      setVisibility(previous)
      setErrorMessage(SAVE_FAILED)
    } finally {
      setIsSaving(false)
    }
  }

  // -1 would hand every radio tabIndex -1 and leave the group unreachable by keyboard.
  const activeIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === visibility),
  )

  function selectOption(next: Visibility): void {
    if (next === visibility || isSaving) return
    if (next === 'public') {
      setIsConfirmingPublic(true)
      return
    }
    // Only a downgrade that leaves live links open needs asking about.
    if (next === 'private' && liveShareLinks > 0) {
      setIsConfirmingPrivate(true)
      return
    }
    void choose(next)
  }

  function handleTrackKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Measured from the focused radio, not the checked one: with manual activation they differ
    // as soon as the first arrow is pressed.
    const focusedIndex = radioRefs.current.findIndex((radio) => radio === event.target)
    const target = radioFocusTarget(
      event.key,
      focusedIndex === -1 ? activeIndex : focusedIndex,
      OPTIONS.length,
    )
    if (target === null) return
    event.preventDefault()
    // Moving focus writes nothing, so it stays available mid-save.
    radioRefs.current[target]?.focus()
  }

  return (
    <div className={styles.wrapper}>
      <div
        className={styles.track}
        role="radiogroup"
        aria-label="Who can open this artifact"
        onKeyDown={handleTrackKeyDown}
      >
        <span
          className={styles.fill}
          style={{ clipPath: clipForIndex(activeIndex) }}
          aria-hidden="true"
        />
        {OPTIONS.map((option, index) => (
          <button
            key={option.value}
            ref={(node) => {
              radioRefs.current[index] = node
              if (option.value === 'public') {
                publicOptionRef.current = node
              }
              if (option.value === 'private') {
                privateOptionRef.current = node
              }
            }}
            className={styles.option}
            type="button"
            role="radio"
            aria-checked={option.value === visibility}
            aria-describedby={`privacy-hint-${option.value}`}
            // `disabled` would drop focus to <body> mid-save; choose() already guards on isSaving.
            aria-disabled={isSaving}
            tabIndex={option.value === visibility ? 0 : -1}
            onClick={() => {
              selectOption(option.value)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className={styles.meta}>
        {OPTIONS.map((option) => (
          <p
            key={option.value}
            className={styles.hint}
            id={`privacy-hint-${option.value}`}
            hidden={option.value !== visibility}
          >
            {hintFor(option.value, liveShareLinks)}
          </p>
        ))}
        {/* Mounted empty and filled on save: a region that arrives with its text is not read. */}
        <p className={styles.saved} role="status" data-testid="privacy-saved">
          {savedNotice}
        </p>
      </div>

      {errorMessage !== null && (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      )}

      <ConfirmDialog
        open={isConfirmingPublic}
        onOpenChange={setIsConfirmingPublic}
        title="Publish to the whole internet?"
        body={PUBLISH_WARNING}
        confirmLabel="Publish publicly"
        cancelLabel="Keep it as it is"
        // Default focus is the first tabbable element — here, the button that publishes.
        initialFocus="cancel"
        finalFocus={publicOptionRef}
        testId="publish-public-dialog"
        confirmTestId="publish-public-confirm"
        onConfirm={() => {
          setIsConfirmingPublic(false)
          void choose('public')
        }}
      />

      <ConfirmDialog
        open={isConfirmingPrivate}
        onOpenChange={setIsConfirmingPrivate}
        title="Share links stay open"
        body={privateConfirmBody(liveShareLinks)}
        confirmLabel="Set to Only me"
        cancelLabel="Keep it as it is"
        initialFocus="cancel"
        finalFocus={privateOptionRef}
        testId="privacy-private-dialog"
        confirmTestId="privacy-private-confirm"
        onConfirm={() => {
          setIsConfirmingPrivate(false)
          void choose('private')
        }}
      />
    </div>
  )
}
