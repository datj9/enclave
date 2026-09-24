'use client'

import Link from 'next/link'
import { useEffect, useRef } from 'react'

import styles from './status-page.module.css'

/**
 * Root error boundary. Without it an unexpected throw in any page below the root layout (a
 * database blip on /dashboard, say) fell through to Next's bare default screen with no way back.
 *
 * `retry` (Next 16.3) re-fetches and re-renders the segment, so a transient server-side failure
 * can recover in place; `reset` only re-renders and would re-show the same error. In production a
 * Server Component error arrives with its message redacted, so only the digest is shown — it is
 * the key that matches the server log line, which is what an operator asks for.
 *
 * Errors in the root layout itself are out of this boundary's reach (that is `global-error.tsx`);
 * the root layout here only loads fonts and CSS.
 */
export default function RootError({
  error,
  retry,
}: {
  readonly error: Error & { readonly digest?: string }
  readonly retry: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    console.error(error)
  }, [error])

  // The boundary swaps the page out from under whatever had focus; land focus on the heading so
  // a keyboard or screen-reader user hears what happened and Tab reaches "Try again" next.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <main className={styles.screen}>
      <h1 className={styles.heading} ref={headingRef} tabIndex={-1}>
        Something went wrong
      </h1>
      <p className={styles.body}>
        This page could not be loaded. Trying again usually works; if it keeps happening, the
        reference below helps whoever runs this instance find the cause.
      </p>
      {error.digest !== undefined && <p className={styles.digest}>Reference {error.digest}</p>}
      <div className={styles.actions}>
        <button className="button-primary" type="button" onClick={() => retry()}>
          Try again
        </button>
        <Link className="button-secondary" href="/dashboard">
          Back to artifacts
        </Link>
      </div>
    </main>
  )
}
