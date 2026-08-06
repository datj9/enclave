import { env } from '@/env'

/** How an artifact is named and addressed. Pure apart from reading the origin template. */

const MAX_SLUG_LENGTH = 80
const SLUG_FALLBACK = 'artifact'

/**
 * A display-only slug. Deliberately not unique and never used to look an artifact up — the id
 * is the only identifier, which is also what keeps the per-artifact origin unguessable (§4.1).
 */
export function slugFromTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    // NFKD splits "í" into "i" + a combining accent; drop the marks so the letter survives
    // rather than becoming a separator.
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')

  return slug === '' ? SLUG_FALLBACK : slug
}

/** `ARTIFACT_ORIGIN_TEMPLATE` with `{id}` filled in, always ending in a slash (§5.7). */
export function artifactViewUrl(artifactId: string): string {
  const origin = env.ARTIFACT_ORIGIN_TEMPLATE.replaceAll('{id}', artifactId)
  return origin.endsWith('/') ? origin : `${origin}/`
}

/**
 * The app-origin page that frames the artifact — the URL a reader is given, and the only one a
 * crawler can index. The artifact origin itself serves the document `no-store` behind a grant
 * cookie, so it is never the canonical address of anything.
 */
export function artifactPageUrl(artifactId: string): string {
  return new URL(`/a/${artifactId}`, env.APP_URL).toString()
}
