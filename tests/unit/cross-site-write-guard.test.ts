import { beforeEach, describe, expect, it, vi } from 'vitest'

import { env } from '@/env'
import { requireApiPrincipal } from '@/lib/auth/bearer'
import type * as RateLimitAuthModule from '@/lib/auth/rate-limit-auth'
import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { getSessionUser } from '@/lib/auth/session'
import { HttpError } from '@/lib/http'
import { POST as changePasswordRoute } from '@app/api/auth/change-password/route'
import { POST as forgotPasswordRoute } from '@app/api/auth/forgot-password/route'
import { POST as resetPasswordRoute } from '@app/api/auth/reset-password/route'
import { POST as signinRoute } from '@app/api/auth/signin/route'
import { POST as signoutRoute } from '@app/api/auth/signout/route'
import { POST as signupRoute } from '@app/api/auth/signup/route'
import { POST as setupRoute } from '@app/api/setup/route'
import { POST as restoreRoute } from '@app/api/v1/artifacts/[id]/restore/route'

/**
 * The origin check wired into the routes that have no JSON body to carry it (§8). Everything the
 * guard itself decides is tests/unit/api-guards.test.ts; this only proves each route refuses a
 * forged request before it authenticates, reads a body or touches Postgres.
 */

vi.mock('@/lib/auth/session', () => ({
  getSessionUser: vi.fn(),
  clearSessionCookie: vi.fn(() => 'enclave_session=; Max-Age=0'),
  createSessionCookie: vi.fn(async () => 'enclave_session=fresh'),
}))

vi.mock('@/lib/auth/rate-limit-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitAuthModule>()),
  enforceAuthRateLimit: vi.fn(),
}))

const getSessionUserMock = vi.mocked(getSessionUser)
const enforceAuthRateLimitMock = vi.mocked(enforceAuthRateLimit)

const APP_ORIGIN = new URL(env.APP_URL).origin
const ARTIFACT_ID = '7f3e0000-0000-4000-8000-0000000000aa'
const ARTIFACT_ORIGIN = new URL(env.ARTIFACT_ORIGIN_TEMPLATE.replaceAll('{id}', ARTIFACT_ID)).origin

const SESSION_USER = {
  id: '7f3e0000-0000-4000-8000-000000000001',
  email: 'ops@example.com',
  role: 'member',
  isActive: true,
} as const

/** What untrusted artifact JavaScript sends when it POSTs to the app with the ambient cookie. */
const FROM_ARTIFACT = { origin: ARTIFACT_ORIGIN, 'sec-fetch-site': 'same-site' } as const

function post(path: string, headers: Record<string, string>, body: string | null = null): Request {
  return new Request(`${APP_ORIGIN}${path}`, { method: 'POST', headers, body })
}

async function errorCodeOf(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code
}

beforeEach(() => {
  getSessionUserMock.mockReset()
  getSessionUserMock.mockResolvedValue(SESSION_USER)
  enforceAuthRateLimitMock.mockReset()
})

describe('requireApiPrincipal session branch', () => {
  it('refuses a cookie-authenticated write from an artifact origin', async () => {
    const request = post('/api/v1/artifacts', FROM_ARTIFACT)

    await expect(requireApiPrincipal(request, 'artifacts:write')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    })
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })

  it('accepts the same write from the app itself', async () => {
    const request = post('/api/v1/artifacts', {
      origin: APP_ORIGIN,
      'sec-fetch-site': 'same-origin',
    })

    await expect(requireApiPrincipal(request, 'artifacts:write')).resolves.toEqual({
      kind: 'user',
      userId: SESSION_USER.id,
    })
  })

  it('leaves a cross-site read alone, since GET changes nothing', async () => {
    const request = new Request(`${APP_ORIGIN}/api/v1/artifacts`, { headers: FROM_ARTIFACT })

    await expect(requireApiPrincipal(request, 'artifacts:read')).resolves.toMatchObject({
      kind: 'user',
    })
  })
})

describe('POST /api/auth/signout', () => {
  it('refuses a forged sign-out and keeps the cookie', async () => {
    const response = await signoutRoute(post('/api/auth/signout', FROM_ARTIFACT))

    expect(response.status).toBe(403)
    expect(await errorCodeOf(response)).toBe('FORBIDDEN')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it("signs out the app's own form post", async () => {
    const response = await signoutRoute(
      post('/api/auth/signout', { origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin' }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/signin')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  })
})

describe('POST /api/auth/change-password', () => {
  it('refuses a forged form post with the 403 envelope, not a redirect', async () => {
    const response = await changePasswordRoute(
      post(
        '/api/auth/change-password',
        { ...FROM_ARTIFACT, 'content-type': 'application/x-www-form-urlencoded' },
        'currentPassword=a&newPassword=b&confirmNewPassword=b',
      ),
    )

    expect(response.status).toBe(403)
    expect(await errorCodeOf(response)).toBe('FORBIDDEN')
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/artifacts/{id}/restore', () => {
  it('refuses a cookie-authenticated restore from an artifact origin', async () => {
    const response = await restoreRoute(
      post(`/api/v1/artifacts/${ARTIFACT_ID}/restore`, FROM_ARTIFACT),
      {
        params: Promise.resolve({ id: ARTIFACT_ID }),
      },
    )

    expect(response.status).toBe(403)
    expect(await errorCodeOf(response)).toBe('FORBIDDEN')
    expect(getSessionUserMock).not.toHaveBeenCalled()
  })
})

/**
 * The unauthenticated form routes hold no session to ride, but a same-site artifact could still
 * post an attacker's credentials and plant the attacker's session in the viewer's browser (login
 * CSRF), or burn the viewer's rate-limit slots and send reset mail in their name.
 */
describe.each([
  ['/api/auth/signin', signinRoute],
  ['/api/auth/signup', signupRoute],
  ['/api/setup', setupRoute],
  ['/api/auth/reset-password', resetPasswordRoute],
  ['/api/auth/forgot-password', forgotPasswordRoute],
])('POST %s', (path, route) => {
  const FORM = { 'content-type': 'application/x-www-form-urlencoded' } as const
  const BODY = 'email=attacker%40example.com&password=correct-horse-battery&token=t'

  it('refuses a forged form post before rate limiting, parsing or any credential work', async () => {
    const response = await route(post(path, { ...FROM_ARTIFACT, ...FORM }, BODY))

    expect(response.status).toBe(403)
    expect(await errorCodeOf(response)).toBe('FORBIDDEN')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(enforceAuthRateLimitMock).not.toHaveBeenCalled()
  })

  it.each([
    ["the app's own form post", { origin: APP_ORIGIN, 'sec-fetch-site': 'same-origin' }],
    ['a client that sends no browser headers (integration suite, Playwright request)', {}],
  ])('lets %s through to the handler', async (_label, headers) => {
    // Stop at the first step after the guard, so the test needs no database.
    enforceAuthRateLimitMock.mockImplementation(() => {
      throw new HttpError('RATE_LIMITED', 'Too many attempts')
    })

    const response = await route(
      post(path, { ...headers, 'content-type': 'application/json' }, '{}'),
    )

    expect(response.status).toBe(429)
    expect(enforceAuthRateLimitMock).toHaveBeenCalledOnce()
  })
})
