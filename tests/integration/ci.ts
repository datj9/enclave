/**
 * Whether this process runs under CI. Every mainstream runner (GitHub Actions included) exports
 * `CI=true`; some export `CI=1`. An explicit `CI=false` / `CI=0` — how a developer opts a local shell
 * back out — is honoured rather than read as "set, therefore CI".
 *
 * Kept free of imports so the unit suite can exercise it without touching the database module.
 */
export function isCi(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env.CI?.trim().toLowerCase()
  if (value === undefined || value === '') return false
  return value !== 'false' && value !== '0'
}

/**
 * The error an integration file raises under CI when a service it needs is down. Locally the same
 * condition skips the file; in CI a skip would turn "Postgres never started" into a green check.
 */
export function missingServicesMessage(availability: {
  readonly database: boolean
  readonly storage: boolean
}): string | null {
  const missing = [
    availability.database ? null : 'Postgres on DATABASE_URL',
    availability.storage ? null : 'S3-compatible storage on S3_ENDPOINT',
  ].filter((name): name is string => name !== null)

  if (missing.length === 0) return null
  return (
    `[enclave] CI is set but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} ` +
    'unreachable. Integration tests fail instead of skipping under CI; start the services ' +
    '(and run `pnpm db:migrate`) before `pnpm test`.'
  )
}

export interface Availability {
  readonly database: boolean
  readonly storage: boolean
}

/**
 * Under CI, a spec's own probe must not be able to skip it. The global setup has already proven
 * both services, so a probe that fails afterwards is a blip (a 3s timeout on a busy runner): retry
 * it, and if it still fails, throw rather than let the file report "skipped" inside a green run.
 * Outside CI this is a single probe, returned as-is so the caller can skip.
 */
export async function probeUntilReady(
  probe: () => Promise<Availability>,
  options: {
    readonly ci?: boolean
    readonly attempts?: number
    readonly delayMs?: number
  } = {},
): Promise<Availability> {
  const { ci = isCi(), attempts = 5, delayMs = 1000 } = options
  let availability = await probe()
  if (!ci) return availability

  for (let attempt = 1; attempt < attempts; attempt++) {
    if (missingServicesMessage(availability) === null) return availability
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    availability = await probe()
  }

  const message = missingServicesMessage(availability)
  if (message !== null) throw new Error(message)
  return availability
}
