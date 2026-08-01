import styles from './workflow-stage.module.css'

interface WorkflowStageProps {
  readonly id: string
  /** Stage label, e.g. `3.0`. Ordinal by design — this page is a four-stage sequence. */
  readonly number: string
  readonly heading: string
  readonly lede: string
  readonly weight: 'normal' | 'lead'
  readonly children: React.ReactNode
  /** Set when the child is a table or code block that should ignore the 65ch reading measure. */
  readonly wide?: boolean
}

export function WorkflowStage({
  id,
  number,
  heading,
  lede,
  weight,
  children,
  wide = false,
}: WorkflowStageProps) {
  return (
    <section className={styles.stage} data-weight={weight} id={id}>
      <p className={styles.number}>{number}</p>
      <h2 className={styles.heading}>{heading}</h2>
      <p className={styles.lede}>{lede}</p>
      <div className={wide ? `${styles.body} ${styles.wide}` : styles.body}>{children}</div>
    </section>
  )
}
