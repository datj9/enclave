import styles from './layout.module.css'

/** Public shell. Renders no session state, so the whole group stays statically renderable. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div className={styles.page}>{children}</div>
}
