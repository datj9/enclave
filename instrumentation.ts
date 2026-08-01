/**
 * Soft startup diagnostics only. The hard env gate lives in scripts/check-env.ts, because
 * Next.js binds its listener *before* calling `register()` — a fail-fast here would already be
 * too late for US-1 AC4.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { warnIfArtifactOriginLooksUnconfigured } = await import('@/lib/startup-checks')
  warnIfArtifactOriginLooksUnconfigured()
}
