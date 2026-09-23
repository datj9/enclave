'use client'

import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'

import { formatBytes } from '@/lib/format/bytes'
import { CopyLinkButton } from '../a/[id]/copy-link-button'
import { fileDoneAnnouncement, isNearBottom, isSubmitShortcut } from './stream-view'
import { useGeneration, type StreamedFile } from './use-generation'
import styles from './prompt-composer.module.css'

/**
 * The §5.4 stream, rendered. Motion follows docs/motion.md § live generation stream: text appends
 * with no per-token animation, one functional indicator, a checkmark per `file_end`, and an
 * auto-scroll that is instant — a smooth scroll loses a race with a fast stream.
 *
 * While a stream runs the controls go `aria-disabled` / `readOnly` rather than `disabled`: a
 * disabled control drops keyboard focus to <body> the moment it is pressed, which is exactly when
 * a keyboard or screen-reader user most needs to stay oriented. Handlers guard on `isStreaming`.
 */

const PLACEHOLDER = 'a countdown timer to new year, with fireworks when it hits zero'

const STARTERS: readonly string[] = [
  'a pomodoro timer with a start, pause, and reset button',
  'a markdown note pad that saves to local storage',
  'a unit converter for length, weight, and temperature',
  'a flashcard quiz app with a deck of 10 questions I can edit',
]

/**
 * Memoised: the reducer keeps the object identity of every file a chunk did not touch, so during a
 * stream only the file being written re-renders — not every finished file above it.
 */
const FilePanel = memo(function FilePanel({ file }: { readonly file: StreamedFile }) {
  const isComplete = file.bytes !== null

  return (
    <section className={styles.file}>
      <header className={styles.fileHead}>
        <span className={styles.filePath}>{file.path}</span>
        {isComplete ? (
          <span className={styles.fileDone}>
            <span aria-hidden="true">✓</span>
            <span className="tabular">{formatBytes(file.bytes ?? 0)}</span>
          </span>
        ) : (
          <span className={styles.fileWriting}>writing</span>
        )}
      </header>
      <pre className={styles.fileBody}>{file.text}</pre>
    </section>
  )
})

/** The artifact origin 404s without a grant cookie, so the address handed out is the app page. */
function ResultPanel({ artifactId }: { readonly artifactId: string }) {
  // Only ever rendered after a generation finished in the browser, so `window` is there.
  const pageUrl = new URL(`/a/${artifactId}`, window.location.origin).toString()
  const panelRef = useRef<HTMLDivElement>(null)

  // Mounted once per finished generation. Focus lands on the panel so the next Tab reaches
  // "Open artifact", instead of leaving the user on a Generate button that has nothing left to do.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  return (
    <div
      className={styles.result}
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="result-heading"
      role="region"
      data-testid="generation-result"
    >
      <h2 className={styles.resultHeading} id="result-heading">
        Artifact ready
      </h2>
      {/* A full load, not next/link: see the /a/{id} note in app/dashboard/artifact-list.tsx. */}
      <a className="button-primary" href={`/a/${artifactId}`}>
        Open artifact
      </a>
      {/* Text only — `status` is atomic, so a button relabelling inside it re-announces the panel. */}
      <p className={styles.resultUrl} role="status">
        {pageUrl}
      </p>
      <CopyLinkButton url={pageUrl} testId="result-copy" />
      <p className={styles.resultCaption}>
        Only you can open it. Choose who else can from the artifact page.
      </p>
    </div>
  )
}

export function PromptComposer() {
  const { state, generate, cancel } = useGeneration()
  const [prompt, setPrompt] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  // Whether the stream panel should follow new output. Starts true for each generation; flips
  // false as soon as the reader scrolls away from the bottom, and back once they return.
  const followRef = useRef(true)
  const isStreaming = state.status === 'streaming'
  const isPromptEmpty = prompt.trim() === ''
  // The prompt Retry replays — held separately from the live textarea so an edit made after a
  // mid-stream failure doesn't turn "retry" into a different request.
  const submittedPromptRef = useRef('')

  // Layout effect: the scroll lands in the same frame as the new text, so there is no flash of
  // the pre-scroll position. Instant, never smooth: motion.md forbids smooth scroll here.
  useLayoutEffect(() => {
    const element = streamRef.current
    if (element !== null && followRef.current) element.scrollTop = element.scrollHeight
  }, [state.files])

  // Leaving mid-stream abandons the request, and the server stops the generation when the
  // connection drops. In-app navigation (next/link) does not fire `beforeunload`; it also does not
  // abort the fetch, so the generation completes and lands on the dashboard either way.
  useEffect(() => {
    if (!isStreaming) return undefined
    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault()
      // Deprecated, but Safari before 17 and older Chromium only prompt when it is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isStreaming])

  function start(nextPrompt: string): void {
    followRef.current = true
    void generate(nextPrompt)
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isStreaming || isPromptEmpty) return
    submittedPromptRef.current = prompt
    start(prompt)
  }

  function onPromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const shortcut = {
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
    }
    if (!isSubmitShortcut(shortcut)) return
    event.preventDefault()
    // requestSubmit, not submit(): it runs the same onSubmit guard a click on Generate runs.
    event.currentTarget.form?.requestSubmit()
  }

  function onStreamScroll(): void {
    const element = streamRef.current
    if (element !== null) followRef.current = isNearBottom(element)
  }

  function onRetry(): void {
    if (isStreaming) return
    start(submittedPromptRef.current)
  }

  return (
    <div className={styles.composer}>
      <form className={styles.form} onSubmit={onSubmit}>
        <div className="field">
          <label className="field-label" htmlFor="prompt">
            Describe the artifact
          </label>
          <textarea
            id="prompt"
            className={`input ${styles.prompt}`}
            name="prompt"
            rows={3}
            maxLength={4000}
            placeholder={PLACEHOLDER}
            value={prompt}
            readOnly={isStreaming}
            aria-describedby="prompt-shortcut"
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={onPromptKeyDown}
          />
          <p className={styles.hint} id="prompt-shortcut">
            <kbd>⌘</kbd> or <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to generate
          </p>
        </div>

        <div className={styles.starters}>
          {STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              className={styles.starter}
              aria-disabled={isStreaming}
              onClick={() => {
                if (!isStreaming) setPrompt(starter)
              }}
            >
              {starter}
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <button
            className="button-primary"
            type="submit"
            aria-disabled={isStreaming || isPromptEmpty}
          >
            {isStreaming ? 'Generating' : 'Generate'}
          </button>
          {isStreaming ? (
            <button className="button-secondary" type="button" onClick={cancel}>
              Stop
            </button>
          ) : null}
          {isStreaming ? (
            <span className={styles.indicator} role="status">
              <span className={styles.pulse} aria-hidden="true" />
              streaming
            </span>
          ) : null}
        </div>
      </form>

      {/* Mounted empty and filled per file: a region that arrives with its text is not read. */}
      <p className="sr-only" role="status" data-testid="generation-file-status">
        {fileDoneAnnouncement(state.files)}
      </p>

      {state.status === 'cancelled' ? (
        <p className={styles.cancelledNotice} role="status">
          Stopped. This attempt still counted against your hourly limit.
        </p>
      ) : null}

      {state.files.length > 0 ? (
        <div className={styles.stream} ref={streamRef} onScroll={onStreamScroll}>
          {state.files.map((file) => (
            <FilePanel key={file.path} file={file} />
          ))}
        </div>
      ) : null}

      {state.failure !== null ? (
        <div className={styles.failure} role="alert">
          <p className={styles.failureMessage}>{state.failure.message}</p>
          <p className={styles.failureCode}>{state.failure.code}</p>
          <button
            className="button-secondary"
            type="button"
            aria-disabled={isStreaming}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      ) : null}

      {state.result !== null ? <ResultPanel artifactId={state.result.artifactId} /> : null}
    </div>
  )
}
