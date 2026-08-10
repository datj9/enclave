/** A CSS-module class types as `string | undefined`; base-ui's `className` prop refuses that. */
export function css(className: string | undefined): string {
  return className ?? ''
}
