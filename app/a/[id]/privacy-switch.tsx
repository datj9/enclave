'use client'

import { Dialog } from '@base-ui-components/react/dialog'
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react'

import { css } from '@/lib/ui/class-name'
import type { Visibility } from '@/db/schema/artifacts'
import styles from './privacy-switch.module.css'
import publishStyles from './publish-dialog.module.css'

/**
 * The owner's privacy control. Motion is a colour + `clip-path` crossfade over 180 ms with no
 * layout shift — docs/motion.md § This project's surfaces. The three options are equal width, so
 * the filled layer slides by re-clipping rather than by resizing anything.
 *
 * These are the three levels that are properties of the artifact. "Anyone with the link" is not
 * one of them: it is a capability derived from an active `share_links` row (§5.1 branch 4), so it
 * lives in the Share dialog next to this control rather than as a fourth segment here.
 *
 * Every level commits on the press except `public`, which confirms first: it is the one transition
 * that hands the artifact to the whole internet, and it is reached by a 1/3-width segment.
 */

interface PrivacyOption {
  readonly value: Visibility
  readonly label: string
  readonly hint: string
}

const OPTIONS: readonly PrivacyOption[] = [
  {
    value: 'private',
    label: 'Only me',
    hint: 'Nobody can browse to it. Any share link you have already created still opens it — revoke those in Share.',
  },
  { value: 'org', label: 'Organization', hint: 'Everyone signed in to this instance can open it.' },
  {
    value: 'public',
    label: 'Public',
    hint: 'Anyone with the address can open it, no sign-in — and search engines may index it.',
  },
]

const SAVE_FAILED = 'That change did not save. The artifact is still set to its previous level.'

const PUBLISH_WARNING =
  "Anyone can open this at its address with no account and no link. Search engines are allowed to index it, and it will appear in this instance's sitemap. You can set it back to Only me at any time — the page stops opening immediately, and leaves the index when the crawler next comes round."

/** APG radiogroup: arrows move focus and selection together, wrapping at both ends. */
const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
}

function clipForIndex(activeIndex: number): string {
  const step = 100 / OPTIONS.length
  return `inset(0 ${(OPTIONS.length - 1 - activeIndex) * step}% 0 ${activeIndex * step}%)`
}

function PublishConfirmDialog({
  isOpen,
  publicOptionRef,
  onOpenChange,
  onConfirm,
}: {
  readonly isOpen: boolean
  readonly publicOptionRef: RefObject<HTMLButtonElement | null>
  readonly onOpenChange: (isOpen: boolean) => void
  readonly onConfirm: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Dialog.Root open={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={css(publishStyles.backdrop)} />
        <Dialog.Popup
          className={css(publishStyles.popup)}
          // Default focus is the first tabbable element — here, the button that publishes.
          initialFocus={cancelRef}
          finalFocus={publicOptionRef}
          data-testid="publish-public-dialog"
        >
          <Dialog.Title className={css(publishStyles.title)}>
            Publish to the whole internet?
          </Dialog.Title>
          <Dialog.Description className={css(publishStyles.description)}>
            {PUBLISH_WARNING}
          </Dialog.Description>

          <div className={publishStyles.actions}>
            <button
              className={publishStyles.confirm}
              type="button"
              data-testid="publish-public-confirm"
              onClick={onConfirm}
            >
              Publish publicly
            </button>
            <Dialog.Close ref={cancelRef} className={css(publishStyles.cancel)}>
              Keep it as it is
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
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
  const [isConfirmingPublic, setIsConfirmingPublic] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const radioRefs = useRef<(HTMLButtonElement | null)[]>([])
  const publicOptionRef = useRef<HTMLButtonElement | null>(null)

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
    void choose(next)
  }

  function moveSelection(fromIndex: number, step: number): void {
    const nextIndex = (fromIndex + step + OPTIONS.length) % OPTIONS.length
    const nextOption = OPTIONS[nextIndex]
    if (nextOption === undefined) return
    radioRefs.current[nextIndex]?.focus()
    selectOption(nextOption.value)
  }

  function handleTrackKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step = ARROW_STEPS[event.key]
    if (step === undefined) return
    event.preventDefault()
    if (isSaving) return

    // Cancelling the publish dialog returns focus to Public while `visibility` is still the old
    // level, so the origin has to be the focused radio rather than the checked one.
    const focusedIndex = radioRefs.current.findIndex((radio) => radio === event.target)
    moveSelection(focusedIndex === -1 ? activeIndex : focusedIndex, step)
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

      <PublishConfirmDialog
        isOpen={isConfirmingPublic}
        publicOptionRef={publicOptionRef}
        onOpenChange={(isOpen) => setIsConfirmingPublic(isOpen)}
        onConfirm={() => {
          setIsConfirmingPublic(false)
          void choose('public')
        }}
      />
    </div>
  )
}
