'use client'

import { useState, type FormEvent } from 'react'

import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS } from '@/lib/invites/limits'
import type { InviteSummary } from '@/lib/invites/manage'
import styles from '../admin.module.css'

/**
 * Create / show-once / list / revoke. The invite URL lives in this component's state and nowhere
 * else — no localStorage and no second read, because the server holds only its SHA-256 digest.
 *
 * No row animation on the table (docs/motion.md).
 */

const GENERIC_FAILURE = 'That did not work. Check the fields and try again.'

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

export function InviteManager({ initialInvites }: { readonly initialInvites: readonly InviteSummary[] }) {
  const [invites, setInvites] = useState(initialInvites)
  const [created, setCreated] = useState<CreatedInviteView | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  async function refresh(): Promise<void> {
    const response = await fetch('/api/v1/invites')
    if (!response.ok) return
    setInvites(((await response.json()) as ListResponse).data.items)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setIsBusy(true)
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
      setCreated({ url: body.data.url, email: email === '' ? null : email, expiresAt: body.data.expiresAt })
      await refresh()
    } finally {
      setIsBusy(false)
    }
  }

  async function handleRevoke(inviteId: string): Promise<void> {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(`/api/v1/invites/${inviteId}`, { method: 'DELETE' })
      if (!response.ok) {
        setErrorMessage('That invite could not be revoked.')
        return
      }
      await refresh()
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <>
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

        <button className="button-primary" type="submit" disabled={isBusy}>
          Create invite
        </button>
      </form>

      <InviteTable
        invites={invites}
        isBusy={isBusy}
        isMountedForLocalTime={isMountedForLocalTime}
        onRevoke={(id) => void handleRevoke(id)}
      />
    </>
  )
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
  return (
    <section className={styles.revealed} aria-live="polite">
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
  readonly onRevoke: (inviteId: string) => void
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
            <tr key={invite.id}>
              <td>{invite.email ?? <span className={styles.muted}>any address</span>}</td>
              <td>{invite.status}</td>
              <td>{formatMoment(invite.expiresAt)}</td>
              <td>{formatMoment(invite.usedAt)}</td>
              <td>{formatMoment(invite.createdAt)}</td>
              <td>
                {invite.status === 'outstanding' ? (
                  <button
                    className={`button-secondary ${styles.compactButton}`}
                    type="button"
                    disabled={isBusy}
                    onClick={() => onRevoke(invite.id)}
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
