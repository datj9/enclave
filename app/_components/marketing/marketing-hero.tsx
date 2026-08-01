import { revealStyle } from './reveal'
import styles from './marketing-hero.module.css'

interface SpecRow {
  readonly term: string
  readonly value: string
}

/** Every row is checkable against docker-compose.yml, package.json and .env.example. */
const RUNS_ON: readonly SpecRow[] = [
  { term: 'Runtime', value: 'Next.js on Node, one container' },
  { term: 'Database', value: 'Postgres 17' },
  { term: 'Storage', value: 'Any S3-compatible bucket' },
  { term: 'Models', value: 'Anthropic, or any OpenAI-compatible endpoint' },
  { term: 'Sign-in', value: 'Email and password, optional OIDC' },
]

export function MarketingHero() {
  return (
    <section className={styles.hero}>
      <div>
        <h1 className={styles.headline} data-reveal style={revealStyle(1)}>
          Generate an artifact. Decide who can open it.
        </h1>
        <p className={styles.lede} data-reveal style={revealStyle(2)}>
          enclave is a web app you host yourself. Describe what you want, a model you point it at
          writes a multi-file HTML page, and enclave serves that page to exactly one of three
          audiences — you alone, everyone signed in to your instance, or anyone holding a link you
          can revoke.
        </p>
      </div>

      <div className={styles.spec} data-reveal style={revealStyle(3)}>
        <h2 className={styles.specHeading}>Runs on</h2>
        <dl className={styles.specList}>
          {RUNS_ON.map((row) => (
            <div className={styles.specRow} key={row.term}>
              <dt className={styles.specTerm}>{row.term}</dt>
              <dd className={styles.specValue}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
