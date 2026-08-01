import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'

/**
 * The S8 worked example end to end through the running app: a signed-in user mints a token in the
 * browser, and a separate client holding only that token — no cookie, exactly what `curl` sends —
 * pushes a bundle that lands owned by the minting user.
 *
 * Sorts after `setup-and-signin.spec.ts` on purpose: that spec asserts `/setup` is still open on
 * an empty database, and Playwright runs spec files in path order with one worker.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const TOKEN_PATTERN = /^enc_[A-Za-z0-9_-]{43}$/

interface CreatedTokenEnvelope {
  readonly data: {
    readonly id: string
    readonly token: string
    readonly name: string
    readonly scopes: readonly string[]
  }
}

interface TokenListEnvelope {
  readonly data: {
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly lastUsedAt: string | null
    }>
  }
}

interface CreatedArtifactEnvelope {
  readonly data: { readonly id: string; readonly viewUrl: string }
}

interface ArtifactListEnvelope {
  readonly data: { readonly items: ReadonlyArray<{ readonly id: string }> }
}

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string }
}

async function signIn(request: APIRequestContext): Promise<void> {
  if ((await request.get('/setup')).status() === 200) {
    await request.post('/api/setup', {
      headers: { 'content-type': 'application/json' },
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      maxRedirects: 0,
    })
    return
  }

  const response = await request.post('/api/auth/signin', {
    headers: { 'content-type': 'application/json' },
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(303)
}

async function mintToken(
  request: APIRequestContext,
  name: string,
  scopes: readonly string[],
): Promise<CreatedTokenEnvelope['data']> {
  const response = await request.post('/api/v1/tokens', {
    headers: { 'content-type': 'application/json' },
    data: { name, scopes },
    maxRedirects: 0,
  })

  expect(response.status()).toBe(201)
  return ((await response.json()) as CreatedTokenEnvelope).data
}

/** No cookie jar, so the only credential in play is the bearer header. */
async function pushBundle(
  agent: APIRequestContext,
  token: string,
  title: string,
): Promise<APIResponse> {
  return agent.post('/api/v1/artifacts', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    data: {
      title,
      visibility: 'private',
      files: [{ path: 'index.html', content: '<h1>ok</h1>' }],
    },
    maxRedirects: 0,
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('scoped API tokens (US-7)', () => {
  test('an agent pushes a bundle with a bearer token and owns nothing else', async ({
    request,
    playwright,
  }) => {
    await signIn(request)
    const minted = await mintToken(request, 'ci', ['artifacts:read', 'artifacts:write'])
    expect(minted.token).toMatch(TOKEN_PATTERN)

    const agent = await playwright.request.newContext()
    try {
      const pushed = await pushBundle(agent, minted.token, 'Agent build')
      expect(pushed.status()).toBe(201)
      const created = (await pushed.json()) as CreatedArtifactEnvelope

      // Read back with the same token: the artifact is in the minting user's list.
      const listed = await agent.get('/api/v1/artifacts?limit=100', {
        headers: { authorization: `Bearer ${minted.token}` },
      })
      const body = (await listed.json()) as ArtifactListEnvelope
      expect(body.data.items.map((item) => item.id)).toContain(created.data.id)
    } finally {
      await agent.dispose()
    }
  })

  test('the token list never returns the value again, and records last use', async ({
    request,
  }) => {
    await signIn(request)
    const response = await request.get('/api/v1/tokens')
    const body = (await response.json()) as TokenListEnvelope

    expect(response.status()).toBe(200)
    expect(JSON.stringify(body)).not.toMatch(TOKEN_PATTERN)

    const ciToken = body.data.items.find((item) => item.name === 'ci')
    expect(ciToken?.lastUsedAt).not.toBeNull()
  })

  test('a token without artifacts:write is refused by name', async ({ request, playwright }) => {
    await signIn(request)
    const readOnly = await mintToken(request, 'read-only', ['artifacts:read'])

    const agent = await playwright.request.newContext()
    try {
      const pushed = await pushBundle(agent, readOnly.token, 'Should not exist')
      const body = (await pushed.json()) as ErrorEnvelope

      expect(pushed.status()).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(body.error.message).toBe('Token lacks scope artifacts:write')
    } finally {
      await agent.dispose()
    }
  })

  test('revoking a token stops it on the next request', async ({ request, playwright }) => {
    await signIn(request)
    const doomed = await mintToken(request, 'doomed', ['artifacts:read'])

    const agent = await playwright.request.newContext()
    try {
      const authorization = { authorization: `Bearer ${doomed.token}` }
      expect((await agent.get('/api/v1/artifacts', { headers: authorization })).status()).toBe(200)

      const revoked = await request.delete(`/api/v1/tokens/${doomed.id}`, { maxRedirects: 0 })
      expect(revoked.status()).toBe(204)

      const after = await agent.get('/api/v1/artifacts', { headers: authorization })
      expect(after.status()).toBe(401)
      expect(((await after.json()) as ErrorEnvelope).error.code).toBe('UNAUTHENTICATED')
    } finally {
      await agent.dispose()
    }
  })

  test('an unauthenticated request is still 401 with no bearer header', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext()
    try {
      const response = await anonymous.post('/api/v1/tokens', {
        headers: { 'content-type': 'application/json' },
        data: { name: 'nope', scopes: ['artifacts:read'] },
        maxRedirects: 0,
      })

      expect(response.status()).toBe(401)
    } finally {
      await anonymous.dispose()
    }
  })

  test('the settings screen shows a new token exactly once', async ({ page }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill(ADMIN_EMAIL)
    await page.getByLabel('Password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/dashboard$/)

    await page.goto('/settings/tokens')
    await page.getByLabel('Name').fill('from-the-ui')
    await page.getByRole('checkbox', { name: 'artifacts:write' }).check()
    await page.getByRole('button', { name: 'Create token' }).click()

    await expect(page.getByText(TOKEN_PATTERN)).toBeVisible()
    await page.getByRole('button', { name: 'I have copied it' }).click()

    // Reloading is the only "second look" a user gets, and it must not contain the value.
    await page.reload()
    await expect(page.getByText('from-the-ui')).toBeVisible()
    await expect(page.getByText(TOKEN_PATTERN)).toBeHidden()
  })
})
