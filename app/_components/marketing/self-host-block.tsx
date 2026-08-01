import styles from './self-host-block.module.css'

/**
 * Verbatim against what the repo ships: `.env.example`, `docker-compose.yml`, and the Dockerfile
 * comment that names `docker compose run --rm app pnpm db:migrate` as the migration path. Nothing
 * here applies migrations implicitly, so the migrate line is not optional.
 *
 * No copy button: `proxy.ts` nonces its CSP per request, so a statically prerendered route gets
 * no nonce and its hydration scripts are refused. Keeping this page static is worth more than the
 * button — the block is five selectable lines.
 */
const COMMANDS = `cp .env.example .env
openssl rand -base64 48          # paste into SESSION_SECRET
openssl rand -base64 48          # paste into ENCRYPTION_KEY
docker compose run --rm app pnpm db:migrate
docker compose up`

export function SelfHostBlock() {
  return (
    <section className={styles.section} id="self-host">
      <h2 className={styles.heading}>Run it yourself</h2>
      <p className={styles.lede}>
        Clone the repository, then five commands. There is no hosted tier to sign up for and
        nothing to wait for.
      </p>

      <div className={styles.frame}>
        <p className={styles.frameLabel}>shell</p>
        <pre className={styles.commands}>
          <code>{COMMANDS}</code>
        </pre>
      </div>

      <ul className={styles.notes}>
        <li>
          The first <code>docker compose up</code> builds the image, then the app answers on{' '}
          <code>http://localhost:3000</code>.
        </li>
        <li>
          Postgres is published on <code>5434</code>, not <code>5432</code> — 5432 and 5433 collide
          with a locally installed Postgres and with Docker Desktop on many machines.
        </li>
        <li>
          Object storage is yours to point at. <code>docker compose --profile minio up -d</code>{' '}
          starts a local MinIO on <code>9000</code> for a demo; in production any S3-compatible
          bucket works.
        </li>
        <li>
          <code>ARTIFACT_ORIGIN_TEMPLATE</code> has to carry the <code>{'{id}'}</code> placeholder —
          each artifact is served from its own hostname, which is what keeps two artifacts apart.
        </li>
        <li>
          Startup refuses to bind a port if <code>SESSION_SECRET</code> or{' '}
          <code>ENCRYPTION_KEY</code> is missing or shorter than 32 bytes. It exits non-zero and
          names the variable.
        </li>
      </ul>
    </section>
  )
}
