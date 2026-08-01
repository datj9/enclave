/**
 * Startup gate. Runs before `next dev` / `next start` and before the container's server, so a
 * missing or short secret exits non-zero *before* a port is bound (US-1 AC4). Next.js binds its
 * listener before running instrumentation.ts, so this check cannot live there.
 *
 * Executed by Node's native type stripping — no build step, no tsx. It therefore imports with an
 * explicit extension, and may only reach modules that are free of path aliases.
 */
import { config as loadDotenv } from 'dotenv'
import { assertEnvOrExit } from '../src/env.ts'

// Mirrors the subset of Next.js' .env precedence this project uses. Neither call overwrites a
// variable already present, so compose's `environment:` block still wins.
loadDotenv({ path: ['.env.local', '.env'], quiet: true })

assertEnvOrExit()
