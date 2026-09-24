'use client'

import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'

import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import type { ShareLinkSummary, ShareableVersion } from '@/lib/shares/manage'
import { cx } from '@/lib/ui/class-name'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import dialogStyles from '@app/_components/ui/dialog.module.css'
import { CopyLinkButton } from './copy-link-button'
import { useOwnerControls } from './owner-controls'
import styles from './share-dialog.module.css'

/**
 * The owner's share surface: pin a version, optionally set an expiry, copy the link once, revoke.
 *
 * Motion is docs/motion.md § This project's surfaces — the popup and backdrop scale
 * `0.96 → 1` with opacity over 220 ms `ease-out` from the centre (the shared modal shell in
 * app/_components/ui/dialog.module.css), the copy button gets the one piece of earned delight,
 * and the revoke button gets none at all.
 *
 * The token lives in this component's state and nowhere else: not localStorage, not the URL, and
 * the server keeps only its hash, so a reload loses it for good.
 *
 * The list and its live count belong to the page's owner controls (owner-controls.tsx), shared
 * with the privacy switch and the Delete confirmation. Revoking asks first, in a ConfirmDialog
 * nested inside this one: a revoke cannot be undone, and the person holding the link gets a 404.
 */

const GENERIC_FAILURE = 'That did not work. Check the fields and try again.'
const REVOKE_FAILED = 'That link could not be revoked. Try again.'
const REVOKE_BODY =
  'Anyone who opens it from now on gets a not-found page. This cannot be undone — create a new link if you need one again.'
const CREATED_ANNOUNCEMENT = 'Share link created. Copy it now — this is the only time it is shown.'

interface CreateResponse {
  readonly data: { readonly shareId: string; readonly token: string; readonly url: string }
}

interface CreatedLink {
  readonly shareId: string
  readonly url: string
}

function versionLabel(version: ShareableVersion): string {
  return version.isCurrent ? `v${version.versionNo} (current)` : `v${version.versionNo}`
}

export function ShareDialog({
  artifactId,
  versions,
}: {
  readonly artifactId: string
  readonly versions: readonly ShareableVersion[]
}) {
  // `liveCount` is counted in Postgres against its own `now()`: an unrevoked link whose expiry has
  // passed opens nothing, so the badge must not offer it as one that does.
  const { shares, liveCount: liveShareCount, refreshShares, markRevoked } = useOwnerControls()
  const [created, setCreated] = useState<CreatedLink | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // One request at a time across create and revoke; which one is running picks the busy label.
  const [busyAction, setBusyAction] = useState<'create' | 'revoke' | null>(null)
  const isBusy = busyAction !== null
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
  const [isRevokeOpen, setIsRevokeOpen] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const isMountedForLocalTime = useIsMountedForLocalTime()
  const createdRef = useRef<HTMLElement>(null)
  /**
   * Where focus goes when the revoke confirmation closes. Left `null` on cancel, so base-ui returns
   * it to the Revoke button that opened it. On success that button is gone — the row now says
   * "Revoked" — so it is pointed at the row itself, which stays.
   */
  const revokeFinalFocus = useRef<HTMLElement | null>(null)
  const revokeRow = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (created !== null) createdRef.current?.focus()
  }, [created])

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isBusy) return
    const form = new FormData(event.currentTarget)
    setBusyAction('create')
    setErrorMessage(null)

    try {
      const response = await fetch(`/api/v1/artifacts/${artifactId}/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createRequestBody(form)),
      })

      if (!response.ok) {
        setErrorMessage(GENERIC_FAILURE)
        return
      }

      const body = (await response.json()) as CreateResponse
      setCreated({ shareId: body.data.shareId, url: body.data.url })
      await refreshShares()
    } catch {
      setErrorMessage(GENERIC_FAILURE)
    } finally {
      setBusyAction(null)
    }
  }

  function requestRevoke(shareId: string, event: MouseEvent<HTMLButtonElement>): void {
    if (isBusy) return
    revokeRow.current = event.currentTarget.closest('li')
    revokeFinalFocus.current = null
    setRevokeError(null)
    setRevokeTarget(shareId)
    setIsRevokeOpen(true)
  }

  async function handleRevoke(): Promise<void> {
    const shareId = revokeTarget
    if (shareId === null || isBusy) return
    setBusyAction('revoke')
    setRevokeError(null)

    try {
      const response = await fetch(`/api/v1/shares/${shareId}`, { method: 'DELETE' })
      if (!response.ok) {
        // Stays open: the failure is shown where the decision was made, and a retry is one press.
        setRevokeError(REVOKE_FAILED)
        return
      }
      // A revoked link's URL is dead, so the copy panel must not keep offering it.
      if (created?.shareId === shareId) setCreated(null)
      markRevoked(shareId)
      revokeFinalFocus.current = revokeRow.current
      setIsRevokeOpen(false)
      await refreshShares()
    } catch {
      setRevokeError(REVOKE_FAILED)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <Dialog.Root>
      <Dialog.Trigger className="button-secondary" data-testid="share-open">
        Share{liveShareCount === 0 ? '' : ` · ${liveShareCount}`}
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className={dialogStyles.backdrop} />
        <Dialog.Popup
          className={cx(dialogStyles.popup, dialogStyles.popupWide)}
          data-testid="share-dialog"
        >
          <Dialog.Title className={dialogStyles.title}>Share this artifact</Dialog.Title>
          <Dialog.Description className={dialogStyles.description}>
            Anyone with the link can open the version you pin, without an account. The link stays on
            that version even after you publish newer ones.
          </Dialog.Description>

          {/* Mounted empty and filled on create: a region that arrives with its text is not read. */}
          <p className="sr-only" role="status">
            {created === null ? '' : CREATED_ANNOUNCEMENT}
          </p>

          {errorMessage !== null && (
            <p className="form-error" role="alert">
              {errorMessage}
            </p>
          )}

          {created !== null && (
            <section className={styles.created} ref={createdRef} tabIndex={-1}>
              <p className={styles.createdHeading}>Copy this link now</p>
              <p className={styles.createdBody}>
                This is the only time it is shown. Nothing can recover it afterwards — create
                another link if you lose it.
              </p>
              <div className={styles.createdRow}>
                <code className={styles.createdUrl} data-testid="share-url">
                  {created.url}
                </code>
                <CopyLinkButton url={created.url} />
              </div>
            </section>
          )}

          <CreateShareForm
            versions={versions}
            isBusy={isBusy}
            isCreating={busyAction === 'create'}
            onSubmit={(event) => void handleCreate(event)}
          />

          <ShareList
            shares={shares}
            versions={versions}
            isBusy={isBusy}
            isMountedForLocalTime={isMountedForLocalTime}
            onRevoke={requestRevoke}
          />

          <Dialog.Close className={styles.done}>Done</Dialog.Close>

          {/* Rendered inside the popup so base-ui treats it as a nested dialog: Esc closes only it. */}
          <ConfirmDialog
            open={isRevokeOpen}
            onOpenChange={setIsRevokeOpen}
            title="Revoke this link?"
            body={REVOKE_BODY}
            confirmLabel={busyAction === 'revoke' ? 'Revoking…' : 'Revoke link'}
            cancelLabel="Keep it"
            tone="danger"
            busy={isBusy}
            error={revokeError}
            finalFocus={revokeFinalFocus}
            testId="share-revoke-dialog"
            confirmTestId="share-revoke-confirm"
            onConfirm={() => void handleRevoke()}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function createRequestBody(form: FormData): Record<string, unknown> {
  const expiresAt = form.get('expiresAt')
  const localExpiry = typeof expiresAt === 'string' && expiresAt !== '' ? expiresAt : null

  return {
    versionId: String(form.get('versionId') ?? ''),
    // `datetime-local` has no zone; the API contract is an ISO instant.
    ...(localExpiry === null ? {} : { expiresAt: new Date(localExpiry).toISOString() }),
  }
}

function CreateShareForm({
  versions,
  isBusy,
  isCreating,
  onSubmit,
}: {
  readonly versions: readonly ShareableVersion[]
  readonly isBusy: boolean
  readonly isCreating: boolean
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className="field">
        <label className="field-label" htmlFor="share-version">
          Version to pin
        </label>
        <select
          className="input"
          id="share-version"
          name="versionId"
          defaultValue={versions.find((version) => version.isCurrent)?.versionId}
          required
        >
          {versions.map((version) => (
            <option key={version.versionId} value={version.versionId}>
              {versionLabel(version)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="share-expires">
          Expires (optional)
        </label>
        <input className="input" id="share-expires" name="expiresAt" type="datetime-local" />
      </div>

      <button
        className="button-primary"
        type="submit"
        aria-disabled={isBusy}
        data-testid="share-create"
      >
        {isCreating ? 'Creating…' : 'Create link'}
      </button>
    </form>
  )
}

function ShareList({
  shares,
  versions,
  isBusy,
  isMountedForLocalTime,
  onRevoke,
}: {
  readonly shares: readonly ShareLinkSummary[]
  readonly versions: readonly ShareableVersion[]
  readonly isBusy: boolean
  readonly isMountedForLocalTime: boolean
  readonly onRevoke: (shareId: string, event: MouseEvent<HTMLButtonElement>) => void
}) {
  if (shares.length === 0) {
    return <p className={styles.empty}>No links yet.</p>
  }

  function formatMoment(iso: string | null): string {
    return isMountedForLocalTime
      ? formatInstantLocal(iso, 'never')
      : formatInstantStable(iso, 'never')
  }

  return (
    <ul className={styles.list}>
      {shares.map((share) => {
        const version = versions.find((candidate) => candidate.versionId === share.versionId)
        return (
          // tabIndex -1: not in the tab order, but a place for focus to land once its Revoke is gone.
          <li className={styles.row} key={share.shareId} tabIndex={-1}>
            <div>
              <p className={styles.rowName}>
                {version === undefined ? 'Removed version' : versionLabel(version)}
              </p>
              <p className={styles.rowMeta}>
                {share.viewCount} {share.viewCount === 1 ? 'view' : 'views'} · last opened{' '}
                {formatMoment(share.lastViewedAt)} · expires {formatMoment(share.expiresAt)}
              </p>
            </div>
            {share.revokedAt === null ? (
              <button
                className={styles.revoke}
                type="button"
                aria-disabled={isBusy}
                data-testid="share-revoke"
                onClick={(event) => onRevoke(share.shareId, event)}
              >
                Revoke
              </button>
            ) : (
              <span className={styles.revoked}>Revoked</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
