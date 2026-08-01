import type { CSSProperties } from 'react'

type RevealStyle = CSSProperties & { readonly '--reveal-index': number }

/**
 * The page's one reveal (design.md § Motion stance) staggers by DOM index. The index rides a
 * custom property because CSS cannot count elements across component boundaries.
 */
export function revealStyle(index: number): RevealStyle {
  return { '--reveal-index': index }
}
