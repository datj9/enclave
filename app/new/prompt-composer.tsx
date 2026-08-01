'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'

import { useGeneration, type StreamedFile } from './use-generation'
import styles from './prompt-composer.module.css'

/**
 * The §5.4 stream, rendered. Motion follows docs/motion.md § live generation stream: text appends
 * with no per-token animation, one functional indicator, a checkmark per `file_end`, and an
 * auto-scroll that is instant — a smooth scroll loses a race with a fast stream.
 */

const PLACEHOLDER = 'a countdown timer to new year, with fireworks when it hits zero'

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

export function PromptComposer() {
  const { state, generate } = useGeneration()
  const [prompt, setPrompt] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const isStreaming = state.status === 'streaming'

  useEffect(() => {
    const element = streamRef.current
    // Instant, never smooth: motion.md forbids smooth scroll under a live stream.
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [state.files])

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (prompt.trim() !== '') void generate(prompt)
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
        <div className={styles.actions}>
          <button
            className="button-primary"
            type="submit"
            disabled={isStreaming || prompt.trim() === ''}
          >
            {isStreaming ? 'Generating' : 'Generate'}
          </button>
          {isStreaming ? (
            <span className={styles.indicator} role="status">
              <span className={styles.pulse} aria-hidden="true" />
              streaming
            </span>
          ) : null}
        </div>
      </form>

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
          <button className="button-secondary" type="button" onClick={() => void generate(prompt)}>
            Retry
          </button>
        </div>
      ) : null}

      {state.result !== null ? (
        <div className={styles.result} role="status">
          <a className="button-primary" href={`/a/${state.result.artifactId}`}>
            Open artifact
          </a>
          <p className={styles.resultUrl}>{state.result.viewUrl}</p>
        </div>
      ) : null}
    </div>
  )
}
