/**
 * C0/C1 controls and DEL cover `\n`, `\r`, `\t` and the ANSI `ESC` that let a title forge a row.
 * The bidi and zero-width ranges are the other half of the same attack: U+202E reverses the
 * rendered order of everything after it, so a title can make a row read as another artifact's
 * without containing a single control byte.
 */
const UNSAFE_DISPLAY_CHARACTERS =
  /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Titles are free text from another user; nothing rendered may corrupt the column layout. */
export function displayTitle(title: string): string {
  return title.replace(UNSAFE_DISPLAY_CHARACTERS, ' ')
}
