'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import { CopyLinkButton } from '../a/[id]/copy-link-button'
import { useGeneration, type StreamedFile } from './use-generation'
import styles from './prompt-composer.module.css'

/**
 * The §5.4 stream, rendered. Motion follows docs/motion.md § live generation stream: text appends
 * with no per-token animation, one functional indicator, a checkmark per `file_end`, and an
 * auto-scroll that is instant — a smooth scroll loses a race with a fast stream.
 */

const PLACEHOLDER = 'a countdown timer to new year, with fireworks when it hits zero'

const STARTERS: readonly string[] = [
  'a pomodoro timer with a start, pause, and reset button',
  'a markdown note pad that saves to local storage',
  'a unit converter for length, weight, and temperature',
  'a flashcard quiz app with a deck of 10 questions I can edit',
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function FilePanel({ file }: { file: StreamedFile }) {
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
}

/** The artifact origin 404s without a grant cookie, so the address handed out is the app page. */
function ResultPanel({ artifactId }: { readonly artifactId: string }) {
  // Only ever rendered after a generation finished in the browser, so `window` is there.
  const pageUrl = new URL(`/a/${artifactId}`, window.location.origin).toString()

  return (
    <div className={styles.result}>
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
  const isStreaming = state.status === 'streaming'
  // The prompt Retry replays — held separately from the live textarea so an edit made after a
  // mid-stream failure doesn't turn "retry" into a different request.
  const submittedPromptRef = useRef('')

  useEffect(() => {
    const element = streamRef.current
    // Instant, never smooth: motion.md forbids smooth scroll under a live stream.
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [state.files])

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (prompt.trim() === '') return
    submittedPromptRef.current = prompt
    void generate(prompt)
  }

  function onRetry(): void {
    void generate(submittedPromptRef.current)
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
            disabled={isStreaming}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <div className={styles.starters}>
          {STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              className={styles.starter}
              disabled={isStreaming}
              onClick={() => setPrompt(starter)}
            >
              {starter}
            </button>
          ))}
        </div>

        <div className={styles.actions}>
          <button
            className="button-primary"
            type="submit"
            disabled={isStreaming || prompt.trim() === ''}
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

      {state.status === 'cancelled' ? (
        <p className={styles.cancelledNotice} role="status">
          Stopped. This attempt still counted against your hourly limit.
        </p>
      ) : null}

      {state.files.length > 0 ? (
        <div className={styles.stream} ref={streamRef}>
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
            disabled={isStreaming}
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
