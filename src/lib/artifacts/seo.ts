import type { Metadata } from 'next'

import type { Visibility } from '@/db/schema/artifacts'

/**
 * What the `/a/{id}` page tells a crawler and a link unfurler. Pure and separate from the page so
 * the one rule that matters here is testable on its own: **only a `public` artifact is indexable.**
 *
 * Nothing in here decides who may read an artifact. `canRead` has already said yes by the time a
 * caller builds metadata, which is also why a title reaching this function is never a leak: an
 * unauthenticated crawler is refused before `generateMetadata` runs.
 */

const SITE_NAME = 'enclave'

/** Search results truncate past roughly this, and a title that ends in "…" reads better there. */
const MAX_TITLE_LENGTH = 60

const MAX_DESCRIPTION_LENGTH = 160

export interface ArtifactSeoInput {
  readonly title: string
  readonly visibility: Visibility
  /** Absolute `/a/{id}` URL on the app origin — `artifactPageUrl` builds it. */
  readonly canonicalUrl: string
}

/** Collapses the whitespace a pasted title arrives with, then truncates on a whole character. */
function clamp(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= limit) return collapsed
  return `${Array.from(collapsed).slice(0, limit - 1).join('').trimEnd()}…`
}

export function artifactPageTitle(title: string): string {
  const clamped = clamp(title, MAX_TITLE_LENGTH)
  return clamped === '' ? `Artifact · ${SITE_NAME}` : `${clamped} · ${SITE_NAME}`
}

/**
 * There is no description column on `artifacts`, and inventing one from the bundle's contents
 * would mean reading the document. The title plus what the page *is* stays honest.
 */
export function artifactPageDescription(title: string, visibility: Visibility): string {
  const clamped = clamp(title, MAX_TITLE_LENGTH)
  const subject = clamped === '' ? 'An artifact' : `“${clamped}”`
  const audience =
    visibility === 'public'
      ? 'Published for anyone to read.'
      : 'Readable only by the audience its owner chose.'
  const sentence = `${subject} — a self-contained web artifact hosted on ${SITE_NAME}. ${audience}`
  return clamp(sentence, MAX_DESCRIPTION_LENGTH)
}

/**
 * `robots` is the whole privacy question of this module. Anything that is not `public` gets
 * `index: false, follow: false` — an org artifact is for signed-in members, and a crawler that
 * followed a link out of one would be indexing an address no search user can open.
 */
export function artifactPageMetadata(input: ArtifactSeoInput): Metadata {
  const title = artifactPageTitle(input.title)
  const description = artifactPageDescription(input.title, input.visibility)
  const isPublic = input.visibility === 'public'

  return {
    title,
    description,
    alternates: { canonical: input.canonicalUrl },
    robots: isPublic
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title,
      description,
      url: input.canonicalUrl,
    },
    twitter: { card: 'summary_large_image', title, description },
  }
}
