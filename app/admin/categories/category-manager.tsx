'use client'

import { useState, type FormEvent } from 'react'

import type { CategoryView } from '@/lib/categories/manage'
import styles from './page.module.css'

/**
 * Create / rename / activate / deactivate the category taxonomy. Mutations go through the admin
 * API and the list is re-read after each one, so the table never diverges from the server.
 *
 * No row animation on the table (docs/motion.md).
 */

interface ListResponse {
  readonly data: { readonly items: readonly CategoryView[] }
}

interface ErrorResponse {
  readonly error: { readonly code: string; readonly message: string }
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ErrorResponse
    if (body.error?.message !== undefined && body.error.message !== '') return body.error.message
  } catch {
    // Non-JSON error bodies fall through to the generic message.
  }
  return 'That did not work. Check the fields and try again.'
}

export function CategoryManager({
  initialCategories,
}: {
  readonly initialCategories: readonly CategoryView[]
}) {
  const [categories, setCategories] = useState(initialCategories)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  async function refresh(): Promise<void> {
    const response = await fetch('/api/v1/categories?includeInactive=true')
    if (!response.ok) {
      setErrorMessage(await readErrorMessage(response))
      return
    }
    setErrorMessage(null)
    const body = (await response.json()) as ListResponse
    setCategories(body.data.items)
  }

  async function runMutation(mutation: () => Promise<Response>): Promise<void> {
    if (isBusy) return
    setIsBusy(true)
    setErrorMessage(null)
    try {
      const response = await mutation()
      if (!response.ok) {
        setErrorMessage(await readErrorMessage(response))
        return
      }
      await refresh()
    } finally {
      setIsBusy(false)
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const description = String(form.get('description') ?? '').trim()
    await runMutation(async () =>
      fetch('/api/v1/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...(description === '' ? {} : { description }) }),
      }),
    )
    if (name !== '') event.currentTarget.reset()
  }

  return (
    <>
      <form className={styles.createForm} onSubmit={(event) => void handleCreate(event)}>
        <div className="field">
          <label className="field-label" htmlFor="category-name">
            Name
          </label>
          <input className="input" id="category-name" name="name" type="text" maxLength={60} />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="category-description">
            Description (optional)
          </label>
          <input
            className="input"
            id="category-description"
            name="description"
            type="text"
            maxLength={500}
          />
        </div>

        <button className="button-primary" type="submit" aria-disabled={isBusy}>
          Create category
        </button>
      </form>

      {errorMessage !== null && (
        <p className="form-error" role="alert">
          {errorMessage}
        </p>
      )}

      {categories.length === 0 ? (
        <p className={styles.empty}>No categories yet.</p>
      ) : (
        <CategoryTable
          categories={categories}
          isBusy={isBusy}
          onRename={(categoryId, name) =>
            void runMutation(() =>
              fetch(`/api/v1/categories/${categoryId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name }),
              }),
            )
          }
          onToggleActive={(categoryId, isActive) =>
            void runMutation(() =>
              fetch(`/api/v1/categories/${categoryId}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ isActive: !isActive }),
              }),
            )
          }
        />
      )}
    </>
  )
}

function CategoryTable({
  categories,
  isBusy,
  onRename,
  onToggleActive,
}: {
  readonly categories: readonly CategoryView[]
  readonly isBusy: boolean
  readonly onRename: (categoryId: string, name: string) => void
  readonly onToggleActive: (categoryId: string, isActive: boolean) => void
}) {
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Slug</th>
            <th scope="col">Description</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.id}>
              <td>
                <RenameControl
                  category={category}
                  isBusy={isBusy}
                  onRename={(name) => onRename(category.id, name)}
                />
              </td>
              <td>
                <span className={styles.mono}>{category.slug}</span>
              </td>
              <td>{category.description ?? <span className={styles.muted}>—</span>}</td>
              <td>
                <span className={category.isActive ? styles.active : styles.muted}>
                  {category.isActive ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td>
                <button
                  className="button-secondary button-sm"
                  type="button"
                  aria-disabled={isBusy}
                  onClick={() => onToggleActive(category.id, category.isActive)}
                >
                  {category.isActive ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RenameControl({
  category,
  isBusy,
  onRename,
}: {
  readonly category: CategoryView
  readonly isBusy: boolean
  readonly onRename: (name: string) => void
}) {
  return (
    <form
      className={styles.renameForm}
      onSubmit={(event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const name = String(form.get('name') ?? '').trim()
        if (name === '' || name === category.name) return
        onRename(name)
      }}
    >
      <input
        className="input"
        type="text"
        maxLength={60}
        name="name"
        defaultValue={category.name}
        key={category.name}
        aria-label={`Rename ${category.name}`}
      />
      <button className="button-secondary button-sm" type="submit" aria-disabled={isBusy}>
        Rename
      </button>
    </form>
  )
}
