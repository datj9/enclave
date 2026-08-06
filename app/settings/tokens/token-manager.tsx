'use client'

import { useState, type FormEvent } from 'react'

import { API_TOKEN_SCOPES, type ApiTokenScope } from '@/db/schema/api-tokens'
import type { ApiTokenSummary } from '@/lib/auth/bearer'
import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import styles from './page.module.css'

/**
 * Create / show-once / list / revoke. The plaintext lives in this component's state and nowhere
 * else — no localStorage, no URL, and the server has only its hash, so a reload loses it for good.
 */

const SCOPE_LABEL: Readonly<Record<ApiTokenScope, string>> = {
  'artifacts:read': 'Read your artifacts',
  'artifacts:write': 'Create artifacts and versions',
  // S5 seam: the scope is grantable now so a token minted today works when share links land.
  'shares:write': 'Create share links (once link sharing ships)',
}

const GENERIC_FAILURE = 'That did not work. Check the fields and try again.'

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
  const [isBusy, setIsBusy] = useState(false)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  async function refreshTokens(): Promise<void> {
    const response = await fetch('/api/v1/tokens')
    if (!response.ok) return
    const body = (await response.json()) as ListResponse
    setTokens(body.data.items)
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setIsBusy(true)
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
    } finally {
      setIsBusy(false)
    }
  }

  async function handleRevoke(tokenId: string): Promise<void> {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(`/api/v1/tokens/${tokenId}`, { method: 'DELETE' })
      if (!response.ok) {
        setErrorMessage('That token could not be revoked.')
        return
      }
      await refreshTokens()
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <>
      {created !== null && (
        <RevealedToken created={created} onDismiss={() => setCreated(null)} />
      )}

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
              <input name="scopes" type="checkbox" value={scope} />
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

        <button className="button-primary" type="submit" disabled={isBusy}>
          Create token
        </button>
      </form>

      <TokenTable
        tokens={tokens}
        isBusy={isBusy}
        isMountedForLocalTime={isMountedForLocalTime}
        onRevoke={(id) => void handleRevoke(id)}
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
  return (
    <section className={styles.revealed} aria-live="polite">
      <h2 className={styles.revealedHeading}>Copy “{created.name}” now</h2>
      <p className={styles.revealedBody}>
        This is the only time it is shown. Nothing can recover it afterwards — create a new token
        if you lose it.
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
  readonly onRevoke: (tokenId: string) => void
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
        <li className={styles.row} key={token.id}>
          <div>
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
              disabled={isBusy}
              onClick={() => onRevoke(token.id)}
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
