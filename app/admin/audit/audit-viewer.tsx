'use client'

import { useState, type FormEvent } from 'react'

import { AUDIT_ACTIONS } from '@/db/schema/audit-log'
import type { AuditEntry, AuditPage } from '@/lib/admin/audit-read'
import styles from '../admin.module.css'

/**
 * Filter by action, actor, artifact, and date range; page forward with the keyset cursor. No row
 * animation and no stagger (docs/motion.md) — this is the densest table in the product.
 */

interface AuditResponse {
  readonly data: AuditPage
}

export interface ActorOption {
  readonly id: string
  readonly email: string
}

const GENERIC_FAILURE = 'That query did not work. Check the filters and try again.'

const MOMENT_PARAMETERS: ReadonlySet<string> = new Set(['from', 'to'])

export function queryFrom(form: FormData, cursor: string | null): string {
  const parameters = new URLSearchParams()
  for (const name of ['action', 'actorUserId', 'artifactId', 'from', 'to']) {
    const value = String(form.get(name) ?? '').trim()
    if (value === '') continue
    if (!MOMENT_PARAMETERS.has(name)) {
      parameters.set(name, value)
      continue
    }
    // `datetime-local` has no zone; the API contract is an absolute instant.
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) continue
    parameters.set(name, parsed.toISOString())
  }
  if (cursor !== null) parameters.set('cursor', cursor)
  return parameters.toString()
}

export function AuditViewer({
  initialPage,
  actors,
}: {
  readonly initialPage: AuditPage
  readonly actors: readonly ActorOption[]
}) {
  const [page, setPage] = useState(initialPage)
  const [entries, setEntries] = useState<readonly AuditEntry[]>(initialPage.items)
  const [filters, setFilters] = useState<FormData | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  async function load(form: FormData, cursor: string | null): Promise<void> {
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await fetch(`/api/v1/audit?${queryFrom(form, cursor)}`)
      if (!response.ok) {
        setErrorMessage(GENERIC_FAILURE)
        return
      }

      const body = (await response.json()) as AuditResponse
      setPage(body.data)
      // Appending on a cursor page, replacing on a fresh filter.
      setEntries((previous) => (cursor === null ? body.data.items : [...previous, ...body.data.items]))
    } finally {
      setIsBusy(false)
    }
  }

  function handleFilter(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setFilters(form)
    void load(form, null)
  }

  function handleMore(): void {
    if (page.nextCursor === null) return
    void load(filters ?? new FormData(), page.nextCursor)
  }

  return (
    <>
      <form className={styles.form} onSubmit={handleFilter}>
        <div className="field">
          <label className="field-label" htmlFor="audit-action">
            Action
          </label>
          <select className="input" id="audit-action" name="action" defaultValue="">
            <option value="">any</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="audit-actor">
            Actor
          </label>
          <select className="input" id="audit-actor" name="actorUserId" defaultValue="">
            <option value="">anyone</option>
            {actors.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.email}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="audit-artifact">
            Artifact id
          </label>
          <input className="input" id="audit-artifact" name="artifactId" type="text" />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="audit-from">
            From
          </label>
          <input className="input" id="audit-from" name="from" type="datetime-local" />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="audit-to">
            To
          </label>
          <input className="input" id="audit-to" name="to" type="datetime-local" />
        </div>

        <button className="button-primary" type="submit" disabled={isBusy}>
          Apply filters
        </button>
      </form>

      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      <AuditTable entries={entries} />

      {page.nextCursor !== null && (
        <div className={styles.pager}>
          <button className="button-secondary" type="button" disabled={isBusy} onClick={handleMore}>
            Load more
          </button>
        </div>
      )}
    </>
  )
}

function AuditTable({ entries }: { readonly entries: readonly AuditEntry[] }) {
  if (entries.length === 0) return <p className={styles.empty}>No matching events.</p>

  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Action</th>
            <th scope="col">Actor</th>
            <th scope="col">IP</th>
            <th scope="col">Artifact</th>
            <th scope="col">Metadata</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{new Date(entry.at).toLocaleString()}</td>
              <td>{entry.action}</td>
              <td>{entry.actorEmail ?? <span className={styles.muted}>—</span>}</td>
              <td className={styles.mono}>{entry.actorIp ?? '—'}</td>
              <td className={styles.mono}>{entry.artifactId ?? '—'}</td>
              <td className={styles.mono}>
                {entry.metadata === null ? '—' : JSON.stringify(entry.metadata)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
