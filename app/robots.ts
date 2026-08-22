import type { MetadataRoute } from 'next'

import { env } from '@/env'

/**
 * `/robots.txt` on the app origin. Only `/a/{id}` is crawlable, and only a `public` artifact
 * answers a crawler there — the page itself carries `robots: noindex` for every other level
 * (src/lib/artifacts/seo.ts), so this file and that header have to agree.
 *
 * `/s/` is disallowed outright: a share token is a capability, and a capability URL must never
 * reach an index (§8). Everything else here is either a signed-in surface or the API.
 *
 * Rendered per request so the `APP_URL` in a self-hosted `.env` is the one that reaches the file,
 * not whatever was set when the image was built.
 */

export const dynamic = 'force-dynamic'

const DISALLOWED: readonly string[] = [
  '/s/',
  '/api/',
  '/dashboard',
  '/trash',
  '/new',
  '/admin',
  '/settings',
  '/signin',
  '/signup',
  '/setup',
  '/forgot-password',
  '/reset-password',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: [...DISALLOWED] }],
    sitemap: new URL('/sitemap.xml', env.APP_URL).toString(),
  }
}
