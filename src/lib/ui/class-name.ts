/** Anything a caller might hand over as a class: a CSS-module lookup, a literal, or a skipped branch. */
export type ClassNamePart = string | false | null | undefined

/**
 * The one class-name helper. Joins the parts that are non-empty strings with single spaces.
 *
 * A CSS-module lookup types as `string | undefined` (a typo'd key is `undefined` at runtime), and
 * conditional classes arrive as `false`. Both drop out here rather than rendering as the literal
 * text "undefined" or "false" in the DOM — the failure mode of a bare template literal.
 */
export function cx(...parts: readonly ClassNamePart[]): string {
  let result = ''
  for (const part of parts) {
    if (typeof part !== 'string' || part === '') continue
    result = result === '' ? part : `${result} ${part}`
  }
  return result
}
