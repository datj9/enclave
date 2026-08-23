import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

/**
 * The design system's measurable contract, asserted against the running app.
 *
 * `design.md` fixes colour, type, and space, and `styles/tokens.css` fixes the control scale.
 * None of that stops a control from being built at the wrong size — these tests are what make
 * the scale enforceable, so a future change that reintroduces a 26px button or a 320px overflow
 * fails here rather than on someone's phone.
 *
 * Three rules, each from a published standard:
 *
 *  1. Tap targets. WCAG 2.5.8 (AA) sets a 24x24 CSS px floor; the pointer guidelines set 44px as
 *     the comfortable target. The app uses --control-sm (32px) for dense surfaces on a fine
 *     pointer and promotes to --control-md (44px) under `pointer: coarse`, so on the touch
 *     project below every interactive control must clear 44.
 *  2. No horizontal overflow. 320px is the narrowest viewport still in real use (iPhone SE).
 *  3. Five type sizes per page, maximum — design.md § Typography rules.
 *
 * The file name sorts after `setup-and-signin.spec.ts`, which asserts `/setup` is still open on
 * an empty database; `signIn` below creates the admin if it has to, so this file also passes
 * on its own.
 */

const ADMIN_EMAIL = 'ops@example.com'
const ADMIN_PASSWORD = 'correct-horse-battery'

/** WCAG 2.5.8 AA. Nothing interactive may be smaller than this on any pointer. */
const WCAG_MIN_TARGET = 24
/** --control-md. The floor once `pointer: coarse` promotion has applied. */
const TOUCH_MIN_TARGET = 44
/** design.md § Typography rules. */
const MAX_TYPE_SIZES_PER_PAGE = 5
/** The narrowest viewport still in real use. */
const NARROW_VIEWPORT = { width: 320, height: 812 }

interface Measured {
  readonly tag: string
  readonly height: number
  readonly width: number
  readonly fontSize: number
  readonly label: string
}

interface PageMeasurement {
  readonly controls: readonly Measured[]
  readonly fontSizes: readonly number[]
  readonly scrollWidth: number
  readonly clientWidth: number
  readonly overflowing: readonly string[]
}

/**
 * Read every interactive control's rendered box in one pass in the page.
 *
 * Zero-sized and `visibility: hidden` nodes are skipped: a control that is not rendered has no
 * target to hit, and a dialog that has never been opened would otherwise report 0px and fail.
 */
async function measure(page: Page): Promise<PageMeasurement> {
  return page.evaluate(() => {
    const SELECTOR = [
      'button',
      'a[href]',
      'input:not([type=hidden])',
      'textarea',
      'select',
      'summary',
      '[role=button]',
      '[role=radio]',
      '[role=tab]',
      '[role=switch]',
    ].join(',')

    const visible = (el: Element): boolean => {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    }

    const controls = Array.from(document.querySelectorAll(SELECTOR))
      .filter(visible)
      .map((el) => {
        const box = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const label =
          (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) ||
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          '(unlabelled)'
        return {
          tag: el.tagName.toLowerCase(),
          height: Number(box.height.toFixed(1)),
          width: Number(box.width.toFixed(1)),
          fontSize: parseFloat(style.fontSize),
          label,
        }
      })

    // Leaf text nodes only: an ancestor reports its own inherited size and would inflate the count.
    const fontSizes = Array.from(
      new Set(
        Array.from(document.querySelectorAll('body *'))
          .filter((el) => el.childElementCount === 0 && (el.textContent ?? '').trim().length > 0)
          .filter(visible)
          .map((el) => parseFloat(getComputedStyle(el).fontSize)),
      ),
    ).sort((a, b) => a - b)

    /*
     * An element wider than the viewport is only a bug when nothing between it and the root
     * scrolls: a wide `<pre>` inside an `overflow-x: auto` pane is a deliberate scroller, not a
     * broken layout. Walk up and let those through.
     */
    const insideScroller = (el: Element): boolean => {
      let node = el.parentElement
      while (node && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX
        if (overflowX === 'auto' || overflowX === 'scroll') return true
        node = node.parentElement
      }
      return false
    }

    const overflowing = Array.from(document.querySelectorAll('body *'))
      .filter(visible)
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .filter((el) => !insideScroller(el))
      .slice(0, 5)
      .map((el) => {
        const box = el.getBoundingClientRect()
        return `<${el.tagName.toLowerCase()} class="${el.className}"> right=${Math.round(box.right)}`
      })

    return {
      controls,
      fontSizes,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      overflowing,
    }
  })
}

function describeTooSmall(controls: readonly Measured[], floor: number): string[] {
  return controls
    .filter((c) => c.height < floor)
    .map((c) => `${c.height}px <${c.tag}> "${c.label}"`)
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

const PUBLIC_PAGES = ['/', '/signin', '/forgot-password'] as const
const SIGNED_IN_PAGES = [
  '/dashboard',
  '/new',
  '/trash',
  '/settings/keys',
  '/settings/tokens',
  '/settings/password',
  '/admin/users',
  '/admin/invites',
  '/admin/categories',
  '/admin/audit',
  '/admin/settings',
] as const

test.describe('design system: control scale', () => {
  /*
   * `hasTouch` is what flips `pointer: coarse`, and the coarse promotion in styles/globals.css is
   * the whole mobile story — so this project, not a narrow viewport alone, is what proves it.
   */
  test.describe('touch pointer', () => {
    test.use({ viewport: NARROW_VIEWPORT, hasTouch: true, isMobile: true })

    for (const path of PUBLIC_PAGES) {
      test(`${path} meets the 44px touch target at 320px`, async ({ page }) => {
        await page.goto(path)
        const measurement = await measure(page)

        expect(measurement.controls.length).toBeGreaterThan(0)
        expect(describeTooSmall(measurement.controls, TOUCH_MIN_TARGET)).toEqual([])
      })
    }

    test('signed-in surfaces meet the 44px touch target at 320px', async ({ page, request }) => {
      await signIn(request)

      for (const path of SIGNED_IN_PAGES) {
        await page.goto(path)
        const measurement = await measure(page)

        expect(
          describeTooSmall(measurement.controls, TOUCH_MIN_TARGET),
          `${path} has controls below ${TOUCH_MIN_TARGET}px`,
        ).toEqual([])
      }
    })
  })

  test.describe('fine pointer', () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test('desktop controls still clear the WCAG 2.5.8 floor', async ({ page, request }) => {
      await signIn(request)

      for (const path of [...PUBLIC_PAGES, ...SIGNED_IN_PAGES]) {
        await page.goto(path)
        const measurement = await measure(page)

        expect(
          describeTooSmall(measurement.controls, WCAG_MIN_TARGET),
          `${path} has controls below the WCAG 2.5.8 floor`,
        ).toEqual([])
      }
    })

    test('a form control and the button beside it share one height', async ({ page }) => {
      await page.goto('/signin')

      const input = await page.getByLabel('Email').boundingBox()
      const button = await page.getByRole('button', { name: /sign in/i }).boundingBox()

      expect(input).not.toBeNull()
      expect(button).not.toBeNull()
      // Same --control-md step: a stray padding change on one of them shows up here.
      expect(Math.abs((input?.height ?? 0) - (button?.height ?? 0))).toBeLessThanOrEqual(1)
    })
  })
})

test.describe('design system: responsive layout', () => {
  for (const width of [320, 360, 375, 414, 768, 1024, 1440]) {
    test(`the marketing page does not scroll sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/')
      const measurement = await measure(page)

      expect(measurement.overflowing, `overflow at ${width}px`).toEqual([])
      expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.clientWidth)
    })
  }

  test('signed-in surfaces do not scroll sideways at 320px', async ({ page, request }) => {
    await signIn(request)
    await page.setViewportSize(NARROW_VIEWPORT)

    for (const path of SIGNED_IN_PAGES) {
      await page.goto(path)
      const measurement = await measure(page)

      expect(measurement.overflowing, `${path} overflows at 320px`).toEqual([])
      expect(measurement.scrollWidth, `${path} scrolls sideways at 320px`).toBeLessThanOrEqual(
        measurement.clientWidth,
      )
    }
  })
})

test.describe('design system: typography', () => {
  test('no page uses more than five type sizes', async ({ page, request }) => {
    await signIn(request)

    for (const path of [...PUBLIC_PAGES, ...SIGNED_IN_PAGES]) {
      await page.goto(path)
      const { fontSizes } = await measure(page)

      expect(
        fontSizes.length,
        `${path} uses ${fontSizes.length} sizes: ${fontSizes.join(', ')}`,
      ).toBeLessThanOrEqual(MAX_TYPE_SIZES_PER_PAGE)
    }
  })

  test('body copy is never below the 16px floor', async ({ page }) => {
    await page.goto('/')
    const smallest = await page.evaluate(() => {
      const paragraphs = Array.from(document.querySelectorAll('p'))
        .filter((el) => (el.textContent ?? '').trim().length > 80)
        .map((el) => parseFloat(getComputedStyle(el).fontSize))
      return paragraphs.length > 0 ? Math.min(...paragraphs) : null
    })

    expect(smallest).not.toBeNull()
    expect(smallest ?? 0).toBeGreaterThanOrEqual(16)
  })
})
