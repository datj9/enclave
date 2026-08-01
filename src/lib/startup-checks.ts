import { env } from '@/env'

/**
 * Wildcard TLS cannot be probed from inside the process, so the next best thing is to name the
 * variable loudly at boot when it is still pointing at a placeholder or a plain-http origin
 * (§7: "startup logs a loud warning naming ARTIFACT_ORIGIN_TEMPLATE").
 */
export function warnIfArtifactOriginLooksUnconfigured(): void {
  const template = env.ARTIFACT_ORIGIN_TEMPLATE

  if (template.startsWith('https://')) return

  console.warn(
    `[enclave] ARTIFACT_ORIGIN_TEMPLATE is "${template}". Artifacts need wildcard DNS and ` +
      'wildcard TLS on their own origin; without https the sandboxed viewer will not be ' +
      'isolated. This is expected in local development only.',
  )
}
