'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'

import { createSubmitGate } from './submit-gate'

/**
 * A submit button that lets its form post once. The auth screens are plain HTML forms that post to
 * route handlers (no client JavaScript required), so a double click or an impatient second Enter
 * sent a second request — burning a rate-limit slot on sign-in, or a second reset email.
 *
 * `useFormStatus` only reports `pending` for forms whose `action` is a function; a form posting to
 * a URL navigates natively and React never sees it. So the lock is a `submit` listener on the
 * owning form, and `useFormStatus` is kept for any form that does use a server action. The listener
 * only runs after hydration — before that the form still works, just unguarded — and `submit` only
 * fires once constraint validation passes, so an invalid form never locks itself.
 *
 * Pending state is `aria-disabled`, not `disabled`: focus stays on the button and screen readers
 * hear the relabel, instead of focus falling to <body> mid-submit.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = 'button-primary',
  testId,
}: {
  readonly children: ReactNode
  /** Shown while the form is posting, e.g. "Signing in". Defaults to the idle label. */
  readonly pendingLabel?: string | undefined
  readonly className?: string
  readonly testId?: string
}) {
  const { pending: isActionPending } = useFormStatus()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const form = buttonRef.current?.form
    if (form === null || form === undefined) return undefined
    const gate = createSubmitGate()

    function onSubmit(event: SubmitEvent): void {
      if (!gate.tryEnter()) {
        event.preventDefault()
        return
      }
      setIsSubmitting(true)
    }

    function onPageShow(event: PageTransitionEvent): void {
      if (!event.persisted) return
      gate.reopen()
      setIsSubmitting(false)
    }

    form.addEventListener('submit', onSubmit)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      form.removeEventListener('submit', onSubmit)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  const isPending = isSubmitting || isActionPending

  return (
    <button
      ref={buttonRef}
      className={className}
      type="submit"
      aria-disabled={isPending}
      data-testid={testId}
    >
      {isPending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  )
}
