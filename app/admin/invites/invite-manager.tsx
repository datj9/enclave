'use client'

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'

import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS } from '@/lib/invites/limits'
import type { InviteSummary } from '@/lib/invites/manage'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import styles from '../admin.module.css'

/**
 * Create / show-once / list / revoke. The invite URL lives in this component's state and nowhere
 * else — no localStorage and no second read, because the server holds only its SHA-256 digest.
 *
 * Revoking asks first: the link may already be in someone's inbox, and a revoked invite cannot
 * be brought back — only replaced by a new one.
 *
 * No row animation on the table (docs/motion.md).
 */

const GENERIC_FAILURE = 'That did not work. Check the fields and try again.'
const REVOKE_FAILED = 'That invite could not be revoked. Try again.'
const CREATED_ANNOUNCEMENT = 'Invite link created. Copy it now — this is the only time it is shown.'

interface CreatedInviteView {
  readonly url: string
  readonly email: string | null
  readonly expiresAt: string
}

interface CreateResponse {
  readonly data: { readonly url: string; readonly expiresAt: string }
}

interface ListResponse {
  readonly data: { readonly items: readonly InviteSummary[] }
}

function requestBodyFrom(form: FormData): Record<string, unknown> {
  const email = String(form.get('email') ?? '').trim()
  const hours = Number(form.get('expiresInHours') ?? DEFAULT_INVITE_TTL_HOURS)

  return {
    ...(email === '' ? {} : { email }),
    expiresInHours: Number.isFinite(hours) ? hours : DEFAULT_INVITE_TTL_HOURS,
  }
}

export function InviteManager({
  initialInvites,
}: {
  readonly initialInvites: readonly InviteSummary[]
}) {
  const [invites, setInvites] = useState(initialInvites)
  const [created, setCreated] = useState<CreatedInviteView | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // One request at a time; which one is running picks the busy label.
  const [busyAction, setBusyAction] = useState<'create' | 'revoke' | null>(null)
  const isBusy = busyAction !== null
  // Kept after close so the dialog does not change its wording during its exit transition.
  const [revokeTarget, setRevokeTarget] = useState<InviteSummary | null>(null)
  const [isRevokeOpen, setIsRevokeOpen] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const isMountedForLocalTime = useIsMountedForLocalTime()
  /**
   * Where focus goes when the confirmation closes. `null` on cancel returns it to the Revoke
   * button; on success that button is gone, so it lands on the row, whose status now says so.
   */
  const revokeFinalFocus = useRef<HTMLElement | null>(null)
  const revokeRow = useRef<HTMLElement | null>(null)

  async function refresh(): Promise<void> {
    const response = await fetch('/api/v1/invites')
    if (!response.ok) return
    setInvites(((await response.json()) as ListResponse).data.items)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isBusy) return
    const form = new FormData(event.currentTarget)
    setBusyAction('create')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/v1/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBodyFrom(form)),
      })

      if (!response.ok) {
        setErrorMessage(GENERIC_FAILURE)
        return
      }

      const body = (await response.json()) as CreateResponse
      const email = String(form.get('email') ?? '').trim()
      setCreated({
        url: body.data.url,
        email: email === '' ? null : email,
        expiresAt: body.data.expiresAt,
      })
      await refresh()
    } catch {
      setErrorMessage(GENERIC_FAILURE)
    } finally {
      setBusyAction(null)
    }
  }

  function requestRevoke(invite: InviteSummary, event: MouseEvent<HTMLButtonElement>): void {
    if (isBusy) return
    revokeRow.current = event.currentTarget.closest('tr')
    revokeFinalFocus.current = null
    setRevokeError(null)
    setRevokeTarget(invite)
    setIsRevokeOpen(true)
  }

  async function handleRevoke(): Promise<void> {
    const invite = revokeTarget
    if (invite === null || isBusy) return
    setBusyAction('revoke')
    setRevokeError(null)
    try {
      const response = await fetch(`/api/v1/invites/${invite.id}`, { method: 'DELETE' })
      if (!response.ok) {
        // Stays open with the reason, so a retry is one press away.
        setRevokeError(REVOKE_FAILED)
        return
      }
      // Marked here rather than by the re-read below, so the Revoke button is already gone when
      // focus is placed on the row — otherwise it would land on that button, then drop to <body>.
      const revokedAt = new Date().toISOString()
      setInvites((current) =>
        current.map((row) =>
          row.id === invite.id ? { ...row, status: 'revoked' as const, revokedAt } : row,
        ),
      )
      revokeFinalFocus.current = revokeRow.current
      setIsRevokeOpen(false)
      await refresh()
    } catch {
      setRevokeError(REVOKE_FAILED)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <>
      {/* Mounted empty and filled on create: a region that arrives with its text is not read. */}
      <p className="sr-only" role="status">
        {created === null ? '' : CREATED_ANNOUNCEMENT}
      </p>

      {created !== null && (
        <RevealedInvite
          created={created}
          isMountedForLocalTime={isMountedForLocalTime}
          onDismiss={() => setCreated(null)}
        />
      )}

      <form className={styles.form} onSubmit={(event) => void handleCreate(event)}>
        {errorMessage !== null && (
          <p className="form-error" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="field">
          <label className="field-label" htmlFor="invite-email">
            Email (optional)
          </label>
          <input
            className="input"
            id="invite-email"
            name="email"
            type="email"
            placeholder="dave@example.com"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="invite-hours">
            Expires in (hours)
          </label>
          <input
            className="input"
            id="invite-hours"
            name="expiresInHours"
            type="number"
            min={1}
            max={MAX_INVITE_TTL_HOURS}
            defaultValue={DEFAULT_INVITE_TTL_HOURS}
          />
        </div>

        <button className="button-primary" type="submit" aria-disabled={isBusy}>
          {busyAction === 'create' ? 'Creating…' : 'Create invite'}
        </button>
      </form>

      <InviteTable
        invites={invites}
        isBusy={isBusy}
        isMountedForLocalTime={isMountedForLocalTime}
        onRevoke={requestRevoke}
      />

      <ConfirmDialog
        open={isRevokeOpen}
        onOpenChange={setIsRevokeOpen}
        title={revokeTitle(revokeTarget)}
        body="The link stops working at once, even if it has already been sent. This cannot be undone — create a new invite if they still need one."
        confirmLabel={busyAction === 'revoke' ? 'Revoking…' : 'Revoke invite'}
        cancelLabel="Keep it"
        tone="danger"
        busy={isBusy}
        error={revokeError}
        finalFocus={revokeFinalFocus}
        testId="invite-revoke-dialog"
        confirmTestId="invite-revoke-confirm"
        onConfirm={() => void handleRevoke()}
      />
    </>
  )
}

function revokeTitle(invite: InviteSummary | null): string {
  const email = invite?.email ?? null
  return email === null ? 'Revoke this invite?' : `Revoke the invite for ${email}?`
}

function RevealedInvite({
  created,
  isMountedForLocalTime,
  onDismiss,
}: {
  readonly created: CreatedInviteView
  readonly isMountedForLocalTime: boolean
  readonly onDismiss: () => void
}) {
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [created])

  return (
    <section className={styles.revealed} ref={panelRef} tabIndex={-1}>
      <h2 className={styles.revealedHeading}>
        Copy this link now{created.email === null ? '' : ` for ${created.email}`}
      </h2>
      <p className={styles.revealedBody}>
        This is the only time it is shown, it works once, and it expires{' '}
        {isMountedForLocalTime
          ? formatInstantLocal(created.expiresAt)
          : formatInstantStable(created.expiresAt)}
        .
      </p>
      <code className={styles.inviteUrl}>{created.url}</code>
      <button className="button-secondary" type="button" onClick={onDismiss}>
        I have copied it
      </button>
    </section>
  )
}

function InviteTable({
  invites,
  isBusy,
  isMountedForLocalTime,
  onRevoke,
}: {
  readonly invites: readonly InviteSummary[]
  readonly isBusy: boolean
  readonly isMountedForLocalTime: boolean
  readonly onRevoke: (invite: InviteSummary, event: MouseEvent<HTMLButtonElement>) => void
}) {
  if (invites.length === 0) return <p className={styles.empty}>No invites yet.</p>

  function formatMoment(iso: string | null): string {
    return isMountedForLocalTime ? formatInstantLocal(iso) : formatInstantStable(iso)
  }

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Email</th>
            <th scope="col">Status</th>
            <th scope="col">Expires</th>
            <th scope="col">Redeemed</th>
            <th scope="col">Created</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {invites.map((invite) => (
            // tabIndex -1: not in the tab order, but a place for focus to land once Revoke is gone.
            <tr key={invite.id} tabIndex={-1}>
              <td>{invite.email ?? <span className={styles.muted}>any address</span>}</td>
              <td>{invite.status}</td>
              <td>{formatMoment(invite.expiresAt)}</td>
              <td>{formatMoment(invite.usedAt)}</td>
              <td>{formatMoment(invite.createdAt)}</td>
              <td>
                {invite.status === 'outstanding' ? (
                  <button
                    className="button-secondary button-sm"
                    type="button"
                    aria-disabled={isBusy}
                    data-testid="invite-revoke"
                    onClick={(event) => onRevoke(invite, event)}
                  >
                    Revoke
                  </button>
                ) : (
                  <span className={styles.muted}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
