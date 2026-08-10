import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * The dashboard pager keeps focus on the completion note after the last `Load more` press, and the
 * always-mounted live region announces the completion to screen readers.
 *
 * The `zz-` prefix is load-bearing: every spec shares one database (workers: 1, fullyParallel:
 * false) and files run in path order. This spec seeds enough artifacts to overflow the first page,
 * which would push `Sales dash` off row 20 and break `upload-and-list.spec.ts`'s
 * `getByRole('link', { name: 'Sales dash' })` assertion if it ran earlier.
 *
 * A mouse click leaves focus on the pressed element and masks the defect, so the whole journey is
 * driven with the keyboard.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

const INDEX_HTML = '<!doctype html><title>pagination filler</title>'

/** The dashboard renders `DEFAULT_LIST_LIMIT` = 20 rows; one more forces a second page. */
const TARGET_TOTAL = 21
/** Presses are capped so a broken pager fails loudly instead of hanging the whole suite. */
const MAX_PAGING_PRESSES = 5
/** A page load on a cold CI runner is slower than Playwright's 5s assertion default. */
const PAGE_LOAD_TIMEOUT_MS = 20_000

interface ListEnvelope {
  readonly data: {
    readonly items: ReadonlyArray<{ readonly id: string; readonly title: string }>
    readonly nextCursor: string | null
  }
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

function fillerBundle(index: number) {
  return {
    title: `pagination filler ${index}`,
    visibility: 'private',
    files: [{ path: 'index.html', content: INDEX_HTML }],
  }
}

async function countArtifacts(request: APIRequestContext): Promise<number> {
  let cursor: string | null = null
  let total = 0
  for (;;) {
    const query = new URLSearchParams({ limit: '100' })
    if (cursor !== null) query.set('cursor', cursor)
    const response = await request.get(`/api/v1/artifacts?${query.toString()}`)
    expect(response.status()).toBe(200)
    const body = (await response.json()) as ListEnvelope
    total += body.data.items.length
    if (body.data.nextCursor === null) break
    cursor = body.data.nextCursor
  }
  return total
}

test.describe('dashboard pager focus and completion announcement', () => {
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext()
    try {
      await signIn(request)
      // Measure, then top up: the specs that ran earlier left an unknown number of artifacts.
      let total = await countArtifacts(request)
      for (let index = 0; total < TARGET_TOTAL; index += 1) {
        const response = await request.post('/api/v1/artifacts', {
          headers: { 'content-type': 'application/json' },
          data: fillerBundle(index),
          maxRedirects: 0,
        })
        expect(response.status()).toBe(201)
        total += 1
      }
    } finally {
      await request.dispose()
    }
  })

  test('the last Load more press keeps focus on the completion note and announces it', async ({
    page,
  }) => {
    await page.goto('/signin')
    await page.getByLabel('Email').fill(ADMIN_EMAIL)
    await page.getByLabel('Password').fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/dashboard$/)

    // Attached and empty is the fix: on today's code this element does not exist at all.
    const status = page.getByTestId('artifacts-pager-status')
    await expect(status).toBeAttached()
    await expect(status).toHaveText('')

    const loadMore = page.getByTestId('artifacts-load-more')
    await expect(loadMore).toBeVisible()

    const rows = page.locator('a[href^="/a/"]')

    for (let press = 0; press < MAX_PAGING_PRESSES; press += 1) {
      if (!(await loadMore.isVisible())) break
      const rowsBefore = await rows.count()
      await loadMore.focus()
      await page.keyboard.press('Enter')
      // Observable progress, not a transient busy flag: either rows arrived or the pager finished.
      await expect
        .poll(
          async () => (await rows.count()) > rowsBefore || !(await loadMore.isVisible()),
          { timeout: PAGE_LOAD_TIMEOUT_MS },
        )
        .toBe(true)
    }
    expect(
      await loadMore.isVisible(),
      `Load more kept appearing after ${MAX_PAGING_PRESSES} presses — the pager never terminated`,
    ).toBe(false)

    await expect(page.getByTestId('artifacts-pager-note')).toBeVisible()
    await expect(status).toHaveText(/All \d+ artifacts loaded\./)

    const focusedTestId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-testid') ?? null,
    )
    expect(focusedTestId).toBe('artifacts-pager-note')
  })
})
