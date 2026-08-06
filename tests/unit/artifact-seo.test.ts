import { describe, expect, it } from 'vitest'

import type { Visibility } from '@/db/schema/artifacts'
import {
  artifactPageDescription,
  artifactPageMetadata,
  artifactPageTitle,
} from '@/lib/artifacts/seo'

/**
 * The `/a/{id}` page's metadata. One rule carries the privacy weight here — `public` is the only
 * level a crawler may index — so it is asserted for every level rather than for the happy path.
 */

const CANONICAL = 'https://enclave.example.com/a/11111111-4444-4444-8444-111111111111'

function metadataFor(visibility: Visibility, title = 'Quarterly burn-down') {
  return artifactPageMetadata({ title, visibility, canonicalUrl: CANONICAL })
}

describe('artifactPageTitle', () => {
  it('names the artifact first and the instance second', () => {
    expect(artifactPageTitle('Quarterly burn-down')).toBe('Quarterly burn-down · enclave')
  })

  it('collapses the whitespace a pasted title arrives with', () => {
    expect(artifactPageTitle('  Quarterly\n  burn-down  ')).toBe('Quarterly burn-down · enclave')
  })

  it('truncates a title too long for a search result, on a whole character', () => {
    const title = artifactPageTitle('x'.repeat(200))

    expect(title.endsWith('… · enclave')).toBe(true)
    expect(title.length).toBeLessThanOrEqual('… · enclave'.length + 59)
  })

  it('still says what the page is when the title is nothing but whitespace', () => {
    expect(artifactPageTitle('   ')).toBe('Artifact · enclave')
  })
})

describe('artifactPageDescription', () => {
  it('says the artifact is published when it is public', () => {
    expect(artifactPageDescription('Quarterly burn-down', 'public')).toContain(
      'Published for anyone to read',
    )
  })

  it('claims no audience it does not have at the other levels', () => {
    for (const visibility of ['private', 'org'] as const) {
      const description = artifactPageDescription('Quarterly burn-down', visibility)

      expect(description).toContain('Readable only by the audience its owner chose')
      expect(description).not.toContain('anyone')
    }
  })

  it('stays inside the length a search result shows', () => {
    expect(artifactPageDescription('y'.repeat(400), 'public').length).toBeLessThanOrEqual(160)
  })
})

describe('artifactPageMetadata — only a public artifact is indexable', () => {
  it('invites the crawler for public', () => {
    expect(metadataFor('public').robots).toEqual({ index: true, follow: true })
  })

  it('refuses the crawler for private and for org', () => {
    for (const visibility of ['private', 'org'] as const) {
      expect(metadataFor(visibility).robots).toEqual({
        index: false,
        follow: false,
        nocache: true,
      })
    }
  })

  it('carries the app-origin canonical URL, never the artifact origin', () => {
    const metadata = metadataFor('public')

    expect(metadata.alternates?.canonical).toBe(CANONICAL)
    expect(metadata.openGraph?.url).toBe(CANONICAL)
  })

  it('puts the same title on the tab, the unfurl card, and the tweet', () => {
    const metadata = metadataFor('public')
    const expected = artifactPageTitle('Quarterly burn-down')

    expect(metadata.title).toBe(expected)
    expect(metadata.openGraph?.title).toBe(expected)
    expect(metadata.twitter?.title).toBe(expected)
  })
})
