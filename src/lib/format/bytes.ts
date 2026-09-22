/**
 * One byte formatter for every surface that shows a size. The composer and the dashboard used to
 * carry their own copies, and the composer's stopped at KB — a 3 MB bundle read "3072.0 KB" there
 * and "3.0 MB" on the dashboard. Binary units (1024) with the familiar KB/MB labels, one decimal
 * above bytes, so a figure never changes width by more than a digit as it grows (callers render it
 * with `tabular-nums`).
 */

const KIBIBYTE = 1024
const MEBIBYTE = KIBIBYTE * 1024

export function formatBytes(bytes: number): string {
  // A size is a count; anything else is a caller bug, but the UI should not print "NaN B".
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0
  if (value < KIBIBYTE) return `${String(value)} B`
  const kibibytes = (value / KIBIBYTE).toFixed(1)
  // Promote on the *rounded* figure, so 1 048 575 bytes reads "1.0 MB" and never "1024.0 KB".
  if (Number(kibibytes) < KIBIBYTE) return `${kibibytes} KB`
  return `${(value / MEBIBYTE).toFixed(1)} MB`
}
