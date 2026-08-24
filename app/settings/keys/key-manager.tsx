'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'

import {
  formatInstantLocal,
  formatInstantStable,
  useIsMountedForLocalTime,
} from '@/lib/format/instant'
import { acceptsBaseUrl, PROVIDER_IDS, type ProviderId } from '@/lib/providers/types'
import type { StoredProviderKeyView } from '@/lib/providers/user-keys'
import styles from './page.module.css'

/**
 * Save / show-last-four / delete. The typed key leaves this component in one `fetch` and is never
 * read back — the server answers with `last4`, so a reload can only ever show that much.
 */

const PROVIDER_LABEL: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic-compatible',
  'openai-compatible': 'OpenAI-compatible',
}

const GENERIC_FAILURE = 'That key could not be saved. Check it and try again.'
const DELETE_FAILURE = 'That key could not be removed. Try again.'

export function KeyManager({ initialKey }: { readonly initialKey: StoredProviderKeyView | null }) {
  const router = useRouter()
  const [storedKey, setStoredKey] = useState(initialKey)
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(
    () => initialKey?.provider ?? PROVIDER_IDS[0],
  )
  // selectedProvider's initializer already defaults to initialKey's provider, so they match here.
  const [baseUrl, setBaseUrl] = useState(() => initialKey?.baseUrl ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const isMountedForLocalTime = useIsMountedForLocalTime()

  function handleProviderChange(provider: ProviderId): void {
    setSelectedProvider(provider)
    setBaseUrl(
      storedKey !== null && storedKey.provider === provider ? (storedKey.baseUrl ?? '') : '',
    )
  }

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
    if (isBusy) return
    setIsBusy(true)
    setErrorMessage(null)

    const formElement = event.currentTarget
    const form = new FormData(formElement)

    try {
      const response = await fetch('/api/v1/settings/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          apiKey: String(form.get('apiKey') ?? ''),
          ...(acceptsBaseUrl(selectedProvider) ? { baseUrl } : {}),
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
    if (isBusy) return
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
      {/* Both branches render, so this region is in the DOM before any change to announce. */}
      <div role="status">
        <StoredKeyRow
          storedKey={storedKey}
          isBusy={isBusy}
          isMountedForLocalTime={isMountedForLocalTime}
          onDelete={() => void handleDelete()}
        />
      </div>

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
            value={selectedProvider}
            onChange={(event) => handleProviderChange(event.target.value as ProviderId)}
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

        {acceptsBaseUrl(selectedProvider) && (
          <div className="field">
            <label className="field-label" htmlFor="key-base-url">
              Base URL
            </label>
            <input
              className="input"
              id="key-base-url"
              name="baseUrl"
              type="url"
              inputMode="url"
              placeholder="https://gateway.example.com/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              required
            />
          </div>
        )}

        <button className="button-primary" type="submit" aria-disabled={isBusy}>
          {storedKey === null ? 'Save key' : 'Update key'}
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
    <section className={styles.row}>
      <div className={styles.rowText}>
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
        {storedKey.baseUrl !== null && <p className={styles.rowBaseUrl}>{storedKey.baseUrl}</p>}
      </div>
      <button className="button-secondary" type="button" aria-disabled={isBusy} onClick={onDelete}>
        Remove
      </button>
    </section>
  )
}
