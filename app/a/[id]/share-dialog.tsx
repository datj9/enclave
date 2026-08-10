'use client'

import { Dialog } from '@base-ui-components/react/dialog'
import { useEffect, useRef, useState, type FormEvent } from 'react'

import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import type { ShareLinkSummary, ShareableVersion } from '@/lib/shares/manage'
import { CopyLinkButton } from './copy-link-button'
import styles from './share-dialog.module.css'

/**
 * The owner's share surface: pin a version, optionally set an expiry, copy the link once, revoke.
 *
 * Motion is docs/motion.md § This project's surfaces — the popup and backdrop scale
 * `0.96 → 1` with opacity over 220 ms `ease-out` from the centre, the copy button gets the one
 * piece of earned delight, and the revoke button gets none at all.
 *
 * The token lives in this component's state and nowhere else: not localStorage, not the URL, and
 * the server keeps only its hash, so a reload loses it for good.
 */

const GENERIC_FAILURE = 'That did not work. Check the fields and try again.'
const REVOKE_FAILED = 'That link could not be revoked.'
const CREATED_ANNOUNCEMENT = 'Share link created. Copy it now — this is the only time it is shown.'

interface CreateResponse {
  readonly data: { readonly shareId: string; readonly token: string; readonly url: string }
}

interface ListResponse {
  readonly data: { readonly items: readonly ShareLinkSummary[]; readonly liveCount: number }
}

/** A CSS-module class types as `string | undefined`; base-ui's `className` prop refuses that. */
function css(className: string | undefined): string {
  return className ?? ''
}

function versionLabel(version: ShareableVersion): string {
  return version.isCurrent ? `v${version.versionNo} (current)` : `v${version.versionNo}`
}

export function ShareDialog({
  artifactId,
  versions,
  initialShares,
  initialLiveCount,
}: {
  readonly artifactId: string
  readonly versions: readonly ShareableVersion[]
  readonly initialShares: readonly ShareLinkSummary[]
  readonly initialLiveCount: number
}) {
  const [shares, setShares] = useState(initialShares)
  // Counted in Postgres against its own `now()`: an unrevoked link whose expiry has passed opens
  // nothing, so the badge must not offer it as one that does.
  const [liveShareCount, setLiveShareCount] = useState(initialLiveCount)
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const isMountedForLocalTime = useIsMountedForLocalTime()
  const createdRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (createdUrl !== null) createdRef.current?.focus()
  }, [createdUrl])

  async function refreshShares(): Promise<void> {
    const response = await fetch(`/api/v1/artifacts/${artifactId}/shares`)
    if (!response.ok) return
    const body = (await response.json()) as ListResponse
    setShares(body.data.items)
    setLiveShareCount(body.data.liveCount)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isBusy) return
    const form = new FormData(event.currentTarget)
    setIsBusy(true)
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
      setCreatedUrl(body.data.url)
      await refreshShares()
    } catch {
      setErrorMessage(GENERIC_FAILURE)
    } finally {
      setIsBusy(false)
    }
  }

  async function handleRevoke(shareId: string): Promise<void> {
    if (isBusy) return
    setIsBusy(true)
    setErrorMessage(null)

    try {
      const response = await fetch(`/api/v1/shares/${shareId}`, { method: 'DELETE' })
      if (!response.ok) {
        setErrorMessage(REVOKE_FAILED)
        return
      }
      // A revoked link's URL is dead, so the copy panel must not keep offering it.
      setCreatedUrl(null)
      await refreshShares()
    } catch {
      setErrorMessage(REVOKE_FAILED)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <Dialog.Root>
      <Dialog.Trigger className="button-secondary" data-testid="share-open">
        Share{liveShareCount === 0 ? '' : ` · ${liveShareCount}`}
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className={css(styles.backdrop)} />
        <Dialog.Popup className={css(styles.popup)} data-testid="share-dialog">
          <Dialog.Title className={css(styles.title)}>Share this artifact</Dialog.Title>
          <Dialog.Description className={css(styles.description)}>
            Anyone with the link can open the version you pin, without an account. The link stays on
            that version even after you publish newer ones.
          </Dialog.Description>

          {/* Mounted empty and filled on create: a region that arrives with its text is not read. */}
          <p className="sr-only" role="status">
            {createdUrl === null ? '' : CREATED_ANNOUNCEMENT}
          </p>

          {errorMessage !== null && (
            <p className="form-error" role="alert">
              {errorMessage}
            </p>
          )}

          {createdUrl !== null && (
            <section className={styles.created} ref={createdRef} tabIndex={-1}>
              <p className={styles.createdHeading}>Copy this link now</p>
              <p className={styles.createdBody}>
                This is the only time it is shown. Nothing can recover it afterwards — create
                another link if you lose it.
              </p>
              <div className={styles.createdRow}>
                <code className={styles.createdUrl} data-testid="share-url">
                  {createdUrl}
                </code>
                <CopyLinkButton url={createdUrl} />
              </div>
            </section>
          )}

          <CreateShareForm
            versions={versions}
            isBusy={isBusy}
            onSubmit={(event) => void handleCreate(event)}
          />

          <ShareList
            shares={shares}
            versions={versions}
            isBusy={isBusy}
            isMountedForLocalTime={isMountedForLocalTime}
            onRevoke={(shareId) => void handleRevoke(shareId)}
          />

          <Dialog.Close className={css(styles.done)}>Done</Dialog.Close>
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
  onSubmit,
}: {
  readonly versions: readonly ShareableVersion[]
  readonly isBusy: boolean
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
        Create link
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
  readonly onRevoke: (shareId: string) => void
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
          <li className={styles.row} key={share.shareId}>
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
                onClick={() => onRevoke(share.shareId)}
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
