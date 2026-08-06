'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { PROVIDER_IDS, type ProviderId } from '@/lib/providers/types'
import type { StoredProviderKeyView } from '@/lib/providers/user-keys'
import styles from './page.module.css'

/**
 * Save / show-last-four / delete. The typed key leaves this component in one `fetch` and is never
 * read back — the server answers with `last4`, so a reload can only ever show that much.
 */

const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  'openai-compatible': 'OpenAI-compatible',
}

const GENERIC_FAILURE = 'That key could not be saved. Check it and try again.'
const DELETE_FAILURE = 'That key could not be removed. Try again.'

export function KeyManager({ initialKey }: { readonly initialKey: StoredProviderKeyView | null }) {
  const router = useRouter()
  const [storedKey, setStoredKey] = useState(initialKey)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  async function refreshStoredKey(): Promise<void> {
    const response = await fetch('/api/v1/settings/keys')
    if (!response.ok) return
    const body = (await response.json()) as { readonly data: StoredProviderKeyView | null }
    setStoredKey(body.data)
    // The daily cap on the page above changes with the key, and it is rendered on the server.
    router.refresh()
  }

  async function handleSave(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const formElement = event.currentTarget
    setIsBusy(true)
    setErrorMessage(null)

    try {
      const response = await fetch('/api/v1/settings/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: String(form.get('provider') ?? ''),
          apiKey: String(form.get('apiKey') ?? ''),
        }),
      })

      if (!response.ok) {
        setErrorMessage(GENERIC_FAILURE)
        return
      }

      formElement.reset()
      await refreshStoredKey()
    } finally {
      setIsBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    setIsBusy(true)
    setErrorMessage(null)

    try {
      const response = await fetch('/api/v1/settings/keys', { method: 'DELETE' })
      if (!response.ok) {
        setErrorMessage(DELETE_FAILURE)
        return
      }
      await refreshStoredKey()
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <>
      <StoredKeyRow
        storedKey={storedKey}
        isBusy={isBusy}
        isMountedForLocalTime={isMountedForLocalTime}
        onDelete={() => void handleDelete()}
      />

      <form className={styles.form} onSubmit={(event) => void handleSave(event)}>
        {errorMessage !== null && (
          <p className="form-error" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="field">
          <label className="field-label" htmlFor="key-provider">
            Provider
          </label>
          <select
            className="input"
            id="key-provider"
            name="provider"
            defaultValue={PROVIDER_IDS[0]}
          >
            {PROVIDER_IDS.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABEL[provider]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="key-value">
            API key
          </label>
          <input
            className="input"
            id="key-value"
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-…"
            required
          />
        </div>

        <button className="button-primary" type="submit" disabled={isBusy}>
          {storedKey === null ? 'Save key' : 'Replace key'}
        </button>
      </form>
    </>
  )
}

function StoredKeyRow({
  storedKey,
  isBusy,
  isMountedForLocalTime,
  onDelete,
}: {
  readonly storedKey: StoredProviderKeyView | null
  readonly isBusy: boolean
  readonly isMountedForLocalTime: boolean
  readonly onDelete: () => void
}) {
  if (storedKey === null) {
    return (
      <p className={styles.empty}>
        No key stored — generations run on the instance key and its lower daily limit.
      </p>
    )
  }

  return (
    <section className={styles.row} aria-live="polite">
      <div>
        <p className={styles.rowName}>
          {PROVIDER_LABEL[storedKey.provider]}{' '}
          <code className={styles.masked}>
            {storedKey.last4 === null ? 'unreadable' : `••••${storedKey.last4}`}
          </code>
        </p>
        <p className={styles.rowMeta}>
          {storedKey.last4 === null
            ? 'This key can no longer be decrypted. Replace it, or remove it to fall back to the instance key.'
            : `Stored ${
                isMountedForLocalTime
                  ? formatInstantLocal(storedKey.createdAt)
                  : formatInstantStable(storedKey.createdAt)
              }`}
        </p>
      </div>
      <button className="button-secondary" type="button" disabled={isBusy} onClick={onDelete}>
        Remove
      </button>
    </section>
  )
}
