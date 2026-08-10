import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * Reads the real values out of styles/tokens.css so a future edit that regresses a pair fails
 * here rather than in a screen reader. Nothing is hardcoded but the thresholds.
 */

interface OklchColor {
  readonly lightness: number
  readonly chroma: number
  readonly hueDegrees: number
}

type TokenPalette = ReadonlyMap<string, OklchColor>

const DECLARATION = /--([a-z0-9-]+):\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/g

function parsePalette(css: string): Map<string, OklchColor> {
  const palette = new Map<string, OklchColor>()
  for (const [, name = '', lightness, chroma, hueDegrees] of css.matchAll(DECLARATION)) {
    palette.set(name, {
      lightness: Number(lightness) / 100,
      chroma: Number(chroma),
      hueDegrees: Number(hueDegrees),
    })
  }
  return palette
}

function readSchemes(): { readonly light: TokenPalette; readonly dark: TokenPalette } {
  const css = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8')
  const darkBlockStart = css.indexOf('@media (prefers-color-scheme: dark)')
  expect(darkBlockStart).toBeGreaterThan(-1)

  const light = parsePalette(css.slice(0, darkBlockStart))
  const dark = new Map(light)
  for (const [name, color] of parsePalette(css.slice(darkBlockStart))) {
    dark.set(name, color)
  }
  return { light, dark }
}

/* OKLab → linear sRGB, per the CSS Color 4 conversion matrices. */
function toLinearSrgb({ lightness, chroma, hueDegrees }: OklchColor): readonly number[] {
  const hueRadians = (hueDegrees * Math.PI) / 180
  const aAxis = chroma * Math.cos(hueRadians)
  const bAxis = chroma * Math.sin(hueRadians)
  const long = (lightness + 0.3963377774 * aAxis + 0.2158037573 * bAxis) ** 3
  const medium = (lightness - 0.1055613458 * aAxis - 0.0638541728 * bAxis) ** 3
  const short = (lightness - 0.0894841775 * aAxis - 1.291485548 * bAxis) ** 3
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ]
}

function relativeLuminance(color: OklchColor): number {
  const [red = 0, green = 0, blue = 0] = toLinearSrgb(color).map((channel) =>
    Math.min(1, Math.max(0, channel)),
  )
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground: OklchColor, background: OklchColor): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

function tokenOf(palette: TokenPalette, name: string): OklchColor {
  const color = palette.get(name)
  if (color === undefined) {
    throw new Error(`${name} is not declared as an oklch() triple in styles/tokens.css`)
  }
  return color
}

const SCHEMES = readSchemes()

describe.each([
  ['light', SCHEMES.light],
  ['dark', SCHEMES.dark],
])('%s scheme', (_scheme, palette: TokenPalette) => {
  it.each([
    ['accent as text on paper', 'color-accent', 'color-paper'],
    ['accent as text on paper-2', 'color-accent', 'color-paper-2'],
    ['accent ink on the accent fill', 'color-accent-ink', 'color-accent'],
  ])('%s clears 4.5:1 (WCAG 1.4.3)', (_pair, foreground, background) => {
    expect(
      contrastRatio(tokenOf(palette, foreground), tokenOf(palette, background)),
    ).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['paper', 'color-paper'],
    ['paper-2', 'color-paper-2'],
  ])('the control border clears 3:1 on %s (WCAG 1.4.11)', (_surface, background) => {
    expect(
      contrastRatio(tokenOf(palette, 'color-control-border'), tokenOf(palette, background)),
    ).toBeGreaterThanOrEqual(3)
  })
})
