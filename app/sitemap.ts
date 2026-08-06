import type { MetadataRoute } from 'next'

import { env } from '@/env'
import { artifactPageUrl } from '@/lib/artifacts/naming'
import { listPublicArtifacts } from '@/lib/artifacts/public-index'

/**
 * `/sitemap.xml` — the marketing page and every `public` artifact, and nothing else. A crawler
 * finding an artifact here can open it, because the same three conditions that put a row in this
 * list are what let `canRead` answer an anonymous viewer (src/lib/artifacts/public-index.ts).
 *
 * Built per request, never at build time: `next build` must not need a database, and a self-hosted
 * image has to honour the `APP_URL` in its own `.env` rather than one baked into the image.
 */

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const published = await listPublicArtifacts()

  return [
    { url: new URL('/', env.APP_URL).toString(), changeFrequency: 'monthly', priority: 1 },
    ...published.map((artifact) => ({
      url: artifactPageUrl(artifact.id),
      lastModified: artifact.updatedAt,
      changeFrequency: 'weekly' as const,
      priority: 0.8,
    })),
  ]
}
