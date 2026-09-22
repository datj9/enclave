import { isCi, missingServicesMessage } from './ci'

/**
 * Integration-project setup file, run before every file in tests/integration/**.
 *
 * Each spec skips itself when Postgres or object storage is unreachable, which is right on a laptop
 * with nothing started and wrong in CI: there a skip means the service containers failed, and the
 * run would still report green. Probing here, once per file and ahead of the spec's own probe,
 * turns that into a hard failure without touching the ~30 files' individual skip logic.
 *
 * `./services` is imported lazily so that a local run (no CI) never pays for the probe twice.
 */
if (isCi()) {
  const { probeServices } = await import('./services')
  const message = missingServicesMessage(await probeServices())
  if (message !== null) throw new Error(message)
}
