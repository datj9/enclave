import type { ReactNode } from 'react'
import styles from './faq-list.module.css'

interface Question {
  readonly question: string
  readonly answer: ReactNode
}

/** Answers describe v1 as scoped in .devkit/grill-result.md §3 — nothing beyond it. */
const QUESTIONS: readonly Question[] = [
  {
    question: 'Can I keep talking to the model to refine an artifact?',
    answer:
      'No. One prompt produces one artifact. Multi-turn chat, forking, and diffing two versions are deliberately outside the first release — generate again if the result is wrong.',
  },
  {
    question: 'Whose API key does it use?',
    answer:
      'The instance key the operator configures, or your own if you store one. Storing your own raises your daily generation limit. A stored key is encrypted at rest and is never returned to the browser.',
  },
  {
    question: 'Can an admin read my private artifacts?',
    answer:
      'No. The admin role manages members, quotas, and the audit log. The read check returns false for an admin on another member’s private artifact, and no admin route serves artifact bytes.',
  },
  {
    question: 'What stops one artifact from reading another?',
    answer: (
      <>
        Every artifact is served from its own hostname and rendered inside a sandboxed{' '}
        <code>iframe</code>, so two artifacts never share a browser origin. Artifact code cannot
        read your session cookie, and it cannot reach another artifact’s storage.
      </>
    ),
  },
  {
    question: 'Can I run it against a local model?',
    answer: (
      <>
        Yes. Point <code>OPENAI_BASE_URL</code> at any OpenAI-compatible endpoint — the provider
        interface treats a local server the same as a hosted one.
      </>
    ),
  },
  {
    question: 'Can one deployment serve several organizations?',
    answer:
      'No. One deployment is one organization, which is why “everyone on this instance” is a precise audience rather than a guess. Run a second instance for a second group.',
  },
]

export function FaqList() {
  return (
    <section className={styles.section} id="questions">
      <h2 className={styles.heading}>Questions</h2>
      <div className={styles.list}>
        {QUESTIONS.map((entry) => (
          <details className={styles.item} key={entry.question}>
            <summary className={styles.question}>{entry.question}</summary>
            <p className={styles.answer}>{entry.answer}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
