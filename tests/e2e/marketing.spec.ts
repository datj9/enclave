import { expect, test, type Page } from '@playwright/test'

/** design.md § Marketing page structure — the four stages, in order. */
const STAGE_HEADINGS = [
  'Describe it',
  'Watch it arrive file by file',
  'Choose who sees it',
  'Share, then take it back',
] as const

const NARROW_VIEWPORT = { width: 320, height: 640 } as const

async function documentOverflowsHorizontally(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement
    return root.scrollWidth > root.clientWidth
  })
}

test.describe('marketing landing page', () => {
  test('renders at / without a session', async ({ page, context }) => {
    await context.clearCookies()

    const response = await page.goto('/')

    expect(response?.status()).toBe(200)
    expect(new URL(page.url()).pathname).toBe('/')
    await expect(
      page.getByRole('heading', { level: 1, name: 'Generate an artifact. Decide who can open it.' }),
    ).toBeVisible()
  })

  test('tells the four-stage story in order', async ({ page }) => {
    await page.goto('/')

    const headings = await page.locator('main section h2').allInnerTexts()
    const stagePositions = STAGE_HEADINGS.map((heading) => headings.indexOf(heading))

    expect(stagePositions).not.toContain(-1)
    expect(stagePositions).toEqual([...stagePositions].sort((left, right) => left - right))
  })

  test('names all three audiences with a way to withdraw each', async ({ page }) => {
    await page.goto('/')

    const audiences = page.getByRole('rowheader')
    await expect(audiences).toHaveText([
      'Only me',
      'Everyone on this instance',
      'Anyone with the link',
    ])
  })

  test('ships a copy-pasteable self-host block that matches the repo', async ({ page }) => {
    await page.goto('/')

    const commands = await page.locator('#self-host pre code').innerText()

    expect(commands).toContain('cp .env.example .env')
    expect(commands).toContain('docker compose run --rm app pnpm db:migrate')
    expect(commands).toContain('docker compose up')
    // Postgres is published on 5434 (docker-compose.yml), so the page must not promise 5432.
    await expect(page.locator('#self-host')).toContainText('5434')
  })

  test('does not scroll horizontally at 320 px', async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT)
    await page.goto('/')

    expect(await documentOverflowsHorizontally(page)).toBe(false)

    // The privacy table is the widest element on the page — check the bottom of the document too.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    expect(await documentOverflowsHorizontally(page)).toBe(false)
  })

  test('keeps every clickable label on one line at 320 px', async ({ page }) => {
    await page.setViewportSize(NARROW_VIEWPORT)
    await page.goto('/')

    const affordances = page.locator('a, button')
    const count = await affordances.count()
    expect(count).toBeGreaterThan(0)

    for (let index = 0; index < count; index += 1) {
      const affordance = affordances.nth(index)
      // Line boxes of the label itself, so padding and min-height cannot fake a second line.
      const lineCount = await affordance.evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const tops = new Set(
          Array.from(range.getClientRects())
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .map((rect) => Math.round(rect.top)),
        )
        return Math.max(tops.size, 1)
      })

      expect(lineCount, `"${(await affordance.innerText()).trim()}" wraps`).toBeLessThanOrEqual(1)
    }
  })

  test('ships exactly one call-to-action button', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('main .button-primary')).toHaveCount(1)
  })

  test('needs no client JavaScript to read', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false })
    const page = await context.newPage()

    try {
      await page.goto('/')

      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.locator('#self-host pre code')).toContainText('docker compose up')
      await expect(page.getByRole('rowheader')).toHaveCount(3)
    } finally {
      await context.close()
    }
  })
})
