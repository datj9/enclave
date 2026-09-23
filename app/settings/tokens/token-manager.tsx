'use client'

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react'

import { API_TOKEN_SCOPES, type ApiTokenScope } from '@/db/schema/api-tokens'
import type { ApiTokenSummary } from '@/lib/auth/bearer'
import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { ConfirmDialog } from '@app/_components/ui/confirm-dialog'
import styles from './page.module.css'

/**
 * Create / show-once / list / revoke. The plaintext lives in this component's state and nowhere
 * else — no localStorage, no URL, and the server has only its hash, so a reload loses it for good.
 *
 * Revoking asks first: whatever runs on the token (a CI job, an agent) starts failing at once, and
 * there is no un-revoke — only a new token to paste everywhere the old one was.
 */

const SCOPE_LABEL: Readonly<Record<ApiTokenScope, string>> = {
  'artifacts:read': 'Read your artifacts',
  'artifacts:write': 'Create artifacts and versions',
  // S5 seam: the scope is grantable now so a token minted today works when share links land.
  'shares:write': 'Create share links (once link sharing ships)',
}

const GENERIC_FAILURE = 'That did not work. Check the fields and try again.'
const REVOKE_FAILED = 'That token could not be revoked. Try again.'
const CREATED_ANNOUNCEMENT = 'API token created. Copy it now — this is the only time it is shown.'

interface CreatedTokenView {
  readonly name: string
  readonly token: string
}

interface CreateResponse {
  readonly data: { readonly token: string; readonly name: string }
}

interface ListResponse {
  readonly data: { readonly items: readonly ApiTokenSummary[] }
}

export function TokenManager({ initialTokens }: { initialTokens: readonly ApiTokenSummary[] }) {
  const [tokens, setTokens] = useState(initialTokens)
  const [created, setCreated] = useState<CreatedTokenView | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // One request at a time; which one is running picks the busy label.
  const [busyAction, setBusyAction] = useState<'create' | 'revoke' | null>(null)
  const isBusy = busyAction !== null
  // Kept after close so the dialog does not change its wording during its exit transition.
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenSummary | null>(null)
  const [isRevokeOpen, setIsRevokeOpen] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const isMountedForLocalTime = useIsMountedForLocalTime()
  /**
   * Where focus goes when the confirmation closes. `null` on cancel returns it to the Revoke
   * button; on success that button is gone, so it lands on the row, which now reads "Revoked".
   */
  const revokeFinalFocus = useRef<HTMLElement | null>(null)
  const revokeRow = useRef<HTMLElement | null>(null)

  async function refreshTokens(): Promise<void> {
    const response = await fetch('/api/v1/tokens')
    if (!response.ok) return
    const body = (await response.json()) as ListResponse
    setTokens(body.data.items)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isBusy) return
    const form = new FormData(event.currentTarget)
    setBusyAction('create')
    setErrorMessage(null)

    try {
      const response = await fetch('/api/v1/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createRequestBody(form)),
      })

      if (!response.ok) {
        setErrorMessage(GENERIC_FAILURE)
        return
      }

      const body = (await response.json()) as CreateResponse
      setCreated({ name: body.data.name, token: body.data.token })
      await refreshTokens()
    } catch {
      setErrorMessage(GENERIC_FAILURE)
    } finally {
      setBusyAction(null)
    }
  }

  function requestRevoke(token: ApiTokenSummary, event: MouseEvent<HTMLButtonElement>): void {
    if (isBusy) return
    revokeRow.current = event.currentTarget.closest('li')
    revokeFinalFocus.current = null
    setRevokeError(null)
    setRevokeTarget(token)
    setIsRevokeOpen(true)
  }

  async function handleRevoke(): Promise<void> {
    const token = revokeTarget
    if (token === null || isBusy) return
    setBusyAction('revoke')
    setRevokeError(null)
    try {
      const response = await fetch(`/api/v1/tokens/${token.id}`, { method: 'DELETE' })
      if (!response.ok) {
        // Stays open with the reason, so a retry is one press away.
        setRevokeError(REVOKE_FAILED)
        return
      }
      // Marked here rather than by the re-read below, so the Revoke button is already gone when
      // focus is placed on the row — otherwise it would land on that button, then drop to <body>.
      const revokedAt = new Date().toISOString()
      setTokens((current) =>
        current.map((row) => (row.id === token.id ? { ...row, revokedAt } : row)),
      )
      revokeFinalFocus.current = revokeRow.current
      setIsRevokeOpen(false)
      await refreshTokens()
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

      {created !== null && <RevealedToken created={created} onDismiss={() => setCreated(null)} />}

      <form className={styles.form} onSubmit={(event) => void handleCreate(event)}>
        {errorMessage !== null && (
          <p className="form-error" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="field">
          <label className="field-label" htmlFor="token-name">
            Name
          </label>
          <input
            className="input"
            id="token-name"
            name="name"
            type="text"
            maxLength={100}
            placeholder="ci"
            required
          />
        </div>

        <fieldset className={styles.scopes}>
          <legend className="field-label">Scopes</legend>
          {API_TOKEN_SCOPES.map((scope) => (
            <label className={styles.scope} key={scope}>
              <input className={styles.scopeCheckbox} name="scopes" type="checkbox" value={scope} />
              <span className={styles.scopeName}>{scope}</span>
              <span className={styles.scopeHint}>{SCOPE_LABEL[scope]}</span>
            </label>
          ))}
        </fieldset>

        <div className="field">
          <label className="field-label" htmlFor="token-expires">
            Expires (optional)
          </label>
          <input className="input" id="token-expires" name="expiresAt" type="datetime-local" />
        </div>

        <button className="button-primary" type="submit" aria-disabled={isBusy}>
          {busyAction === 'create' ? 'Creating…' : 'Create token'}
        </button>
      </form>

      <TokenTable
        tokens={tokens}
        isBusy={isBusy}
        isMountedForLocalTime={isMountedForLocalTime}
        onRevoke={requestRevoke}
      />

      <ConfirmDialog
        open={isRevokeOpen}
        onOpenChange={setIsRevokeOpen}
        title={revokeTarget === null ? 'Revoke this token?' : `Revoke “${revokeTarget.name}”?`}
        body="Anything still using it — a CI job, an agent, the CLI — is refused from the next request on. This cannot be undone; you would create a new token and replace it everywhere."
        confirmLabel={busyAction === 'revoke' ? 'Revoking…' : 'Revoke token'}
        cancelLabel="Keep it"
        tone="danger"
        busy={isBusy}
        error={revokeError}
        finalFocus={revokeFinalFocus}
        testId="token-revoke-dialog"
        confirmTestId="token-revoke-confirm"
        onConfirm={() => void handleRevoke()}
      />
    </>
  )
}

function createRequestBody(form: FormData): Record<string, unknown> {
  const expiresAt = form.get('expiresAt')
  const localExpiry = typeof expiresAt === 'string' && expiresAt !== '' ? expiresAt : null

  return {
    name: String(form.get('name') ?? ''),
    scopes: form.getAll('scopes').map(String),
    // `datetime-local` has no zone; the API contract is an ISO instant.
    ...(localExpiry === null ? {} : { expiresAt: new Date(localExpiry).toISOString() }),
  }
}

function RevealedToken({
  created,
  onDismiss,
}: {
  readonly created: CreatedTokenView
  readonly onDismiss: () => void
}) {
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [created])

  return (
    <section className={styles.revealed} ref={panelRef} tabIndex={-1}>
      <h2 className={styles.revealedHeading}>Copy “{created.name}” now</h2>
      <p className={styles.revealedBody}>
        This is the only time it is shown. Nothing can recover it afterwards — create a new token if
        you lose it.
      </p>
      <code className={styles.tokenValue}>{created.token}</code>
      <button className="button-secondary" type="button" onClick={onDismiss}>
        I have copied it
      </button>
    </section>
  )
}

function TokenTable({
  tokens,
  isBusy,
  isMountedForLocalTime,
  onRevoke,
}: {
  readonly tokens: readonly ApiTokenSummary[]
  readonly isBusy: boolean
  readonly isMountedForLocalTime: boolean
  readonly onRevoke: (token: ApiTokenSummary, event: MouseEvent<HTMLButtonElement>) => void
}) {
  if (tokens.length === 0) {
    return <p className={styles.empty}>No tokens yet.</p>
  }

  function formatMoment(iso: string | null): string {
    return isMountedForLocalTime
      ? formatInstantLocal(iso, 'never')
      : formatInstantStable(iso, 'never')
  }

  return (
    <ul className={styles.list}>
      {tokens.map((token) => (
        // tabIndex -1: not in the tab order, but a place for focus to land once its Revoke is gone.
        <li className={styles.row} key={token.id} tabIndex={-1}>
          <div className={styles.rowText}>
            <p className={styles.rowName}>{token.name}</p>
            <p className={styles.rowMeta}>
              {token.scopes.join(', ')} · last used {formatMoment(token.lastUsedAt)} · expires{' '}
              {formatMoment(token.expiresAt)}
            </p>
          </div>
          {token.revokedAt === null ? (
            <button
              className="button-secondary"
              type="button"
              aria-disabled={isBusy}
              data-testid="token-revoke"
              onClick={(event) => onRevoke(token, event)}
            >
              Revoke
            </button>
          ) : (
            <span className={styles.revoked}>Revoked</span>
          )}
        </li>
      ))}
    </ul>
  )
}
