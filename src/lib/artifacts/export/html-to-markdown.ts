import TurndownService from 'turndown'

/**
 * The `.md` download: the entry document's raw HTML converted to markdown, server-side. Lossy on
 * purpose — the download is a text export, not a re-render, so nothing in the bundle besides the
 * entry document participates.
 *
 * A fresh service per call keeps this module stateless and safe to call concurrently; turndown
 * also has no mutable configuration worth sharing.
 */

export function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService()
  // Turndown keeps these bodies as text by default, so an app's CSS and JS would land in the .md.
  turndown.remove(['script', 'style', 'noscript', 'template', 'title'])
  return turndown.turndown(html)
}