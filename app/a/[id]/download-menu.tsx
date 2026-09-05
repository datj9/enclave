'use client'

import { Menu } from '@base-ui-components/react/menu'
import { useState } from 'react'

import styles from './download-menu.module.css'

/**
 * The per-format download menu on both the viewer page (`/a/{id}`) and the share page
 * (`/s/{token}`). Rendered for every authorized viewer, outside the owner-only toolbar.
 *
 * `.md` and `.html` are plain navigations to the download route — the `attachment` header makes
 * the browser save the file. `.pdf` is client-side: it fetches the self-contained HTML, opens a
 * new window on an object URL, and prints it. No server-side PDF, no headless browser, and no
 * `sonner` toast here — the app mounts no `<Toaster/>`, so failures surface as an inline
 * `role="alert"` like `share-dialog.tsx` does.
 *
 * Note the inlined artifact `<script>` will not execute under the opener's `script-src` CSP: the
 * printed PDF is the un-hydrated HTML. Acceptable — and tests must not assert JS-rendered content.
 */

const PRINT_ERROR = 'The PDF could not be prepared.'
const POPUP_BLOCKED_ERROR = 'The pop-up was blocked. Allow pop-ups and try again.'
/** Safari never fires `afterprint`; the object URL must still be revoked, eventually. */
const REVOKE_FALLBACK_MS = 60_000

/** A CSS-module class types as `string | undefined`; base-ui's `className` prop refuses that. */
function css(className: string | undefined): string {
  return className ?? ''
}

export function DownloadMenu({ downloadBasePath }: { readonly downloadBasePath: string }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function downloadPdf(): Promise<void> {
    setErrorMessage(null)
    let blob: Blob
    try {
      const response = await fetch(`${downloadBasePath}?format=html`)
      if (!response.ok) {
        setErrorMessage(PRINT_ERROR)
        return
      }
      blob = await response.blob()
    } catch {
      setErrorMessage(PRINT_ERROR)
      return
    }

    const url = URL.createObjectURL(blob)
    const win = window.open(url)
    if (win === null) {
      URL.revokeObjectURL(url)
      setErrorMessage(POPUP_BLOCKED_ERROR)
      return
    }

    win.addEventListener('load', () => win.print())
    let revoked = false
    const revoke = (): void => {
      if (!revoked) {
        revoked = true
        URL.revokeObjectURL(url)
      }
    }
    win.addEventListener('afterprint', revoke, { once: true })
    window.setTimeout(revoke, REVOKE_FALLBACK_MS)
  }

  return (
    <Menu.Root>
      <Menu.Trigger className="button-secondary" data-testid="download-open">
        Download
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className={css(styles.positioner)} side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className={css(styles.popup)} data-testid="download-menu">
            {errorMessage !== null && (
              <p className="form-error" role="alert">
                {errorMessage}
              </p>
            )}
            <Menu.Item
              className={css(styles.item)}
              data-testid="download-md"
              render={<a href={`${downloadBasePath}?format=md`} />}
            >
              Markdown (.md)
            </Menu.Item>
            <Menu.Item
              className={css(styles.item)}
              data-testid="download-html"
              render={<a href={`${downloadBasePath}?format=html`} />}
            >
              HTML (.html)
            </Menu.Item>
            <Menu.Item
              className={css(styles.item)}
              data-testid="download-pdf"
              closeOnClick={false}
              onClick={() => void downloadPdf()}
            >
              PDF (print)
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}