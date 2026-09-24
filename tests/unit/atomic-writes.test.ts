import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Multi-statement writes that must land whole or not at all, with the driver replaced by a
 * recording fake: every statement has to go through the transaction handle (the pool refuses
 * writes here), and audit rows are written only after the transaction has committed. Rollback
 * itself is Postgres's job; what this pins is that the statements are inside one.
 */

type Step = readonly [string, ...unknown[]]

const fake = vi.hoisted(() => {
  const steps: Step[] = []
  const state = { failOn: undefined as string | undefined }

  function chain(label: string, result: () => unknown): unknown {
    const target = {
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            if (state.failOn === label) throw new Error(`${label} failed`)
            return result()
          })
          .then(resolve, reject),
    }
    const proxy: unknown = new Proxy(target, {
      get: (object, property) => {
        if (property === 'then') return object.then
        return () => proxy
      },
    })
    return proxy
  }

  const transaction = {
    execute: () => {
      steps.push(['tx.execute'])
      return Promise.resolve()
    },
    insert: (table: unknown) => {
      steps.push(['tx.insert', table])
      return chain('tx.insert', () => undefined)
    },
    delete: (table: unknown) => {
      steps.push(['tx.delete', table])
      return chain('tx.delete', () => undefined)
    },
    update: (table: unknown) => {
      steps.push(['tx.update', table])
      return chain('tx.update', () => [
        {
          id: ARTIFACT_ID,
          title: 'Renamed',
          slug: 'renamed',
          visibility: 'private',
          createdAt: new Date('2026-08-01T00:00:00Z'),
          updatedAt: new Date('2026-08-01T00:00:00Z'),
        },
      ])
    },
  }

  const refuse = (what: string) => () => {
    throw new Error(`${what} must go through the transaction, not the pool`)
  }

  const db = {
    transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => {
      steps.push(['db.transaction'])
      const value = await callback(transaction)
      steps.push(['db.commit'])
      return value
    },
    insert: refuse('insert'),
    delete: refuse('delete'),
    update: refuse('update'),
    // `readArtifactTags` is the only pool read on these paths.
    select: () => chain('db.select', () => []),
  }

  const ARTIFACT_ID = '7f3e0000-0000-4000-8000-0000000000c1'
  return { steps, state, transaction, db, ARTIFACT_ID }
})

const OWNER_ID = '7f3e0000-0000-4000-8000-0000000000c2'
const ARTIFACT_ID = fake.ARTIFACT_ID

vi.mock('@/db', () => ({ db: fake.db }))

vi.mock('@/lib/audit', () => ({
  recordAuditEvent: vi.fn(() => {
    fake.steps.push(['audit'])
    return Promise.resolve()
  }),
}))

vi.mock('@/lib/artifacts/authorize', () => ({
  resolveViewer: () => Promise.resolve({ kind: 'user', id: OWNER_ID }),
  loadArtifactForRead: () =>
    Promise.resolve({ artifact: { ownerId: OWNER_ID, visibility: 'private' }, version: {} }),
}))

vi.mock('@/lib/artifacts/can-read', () => ({ canRead: () => true }))

const { recordAuditEvent } = await import('@/lib/audit')
const { userProviderKeys } = await import('@/db/schema/user-provider-keys')
const { artifactCategories } = await import('@/db/schema/categories')
const { artifacts } = await import('@/db/schema/artifacts')
const { storeUserProviderKey } = await import('@/lib/providers/user-keys')
const { updateArtifactWithTags } = await import('@/lib/artifacts/tags')

function stepNames(): string[] {
  return fake.steps.map(([name]) => name)
}

beforeEach(() => {
  fake.steps.length = 0
  fake.state.failOn = undefined
  vi.clearAllMocks()
})

describe('storeUserProviderKey', () => {
  it('upserts the new key and deletes the other provider’s in one locked transaction', async () => {
    await storeUserProviderKey(OWNER_ID, 'openai-compatible', 'sk-proj-0123456789', undefined)

    expect(fake.steps).toEqual([
      ['db.transaction'],
      ['tx.execute'],
      ['tx.insert', userProviderKeys],
      ['tx.delete', userProviderKeys],
      ['db.commit'],
    ])
  })

  it('does not commit when the delete fails, so the user is never left holding two keys', async () => {
    fake.state.failOn = 'tx.delete'

    await expect(
      storeUserProviderKey(OWNER_ID, 'openai-compatible', 'sk-proj-0123456789', undefined),
    ).rejects.toThrow('tx.delete failed')
    expect(stepNames()).not.toContain('db.commit')
  })
})

describe('updateArtifactWithTags', () => {
  it('writes the rename and the tag replacement on one transaction, then audits', async () => {
    const categoryId = '7f3e0000-0000-4000-8000-0000000000c3'

    const result = await updateArtifactWithTags({
      artifactId: ARTIFACT_ID,
      viewerRef: `user:${OWNER_ID}`,
      patch: { title: 'Renamed', categoryIds: [categoryId, categoryId] },
    })

    expect(fake.steps).toEqual([
      ['db.transaction'],
      ['tx.update', artifacts],
      ['tx.delete', artifactCategories],
      ['tx.insert', artifactCategories],
      ['tx.update', artifacts],
      ['db.commit'],
      ['audit'],
    ])
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'artifact.tag_change',
        actorUserId: OWNER_ID,
        metadata: { categoryIds: [categoryId], categorySource: 'manual' },
      }),
    )
    expect(result.tagsReplaced).toBe(true)
    expect(result.artifact.title).toBe('Renamed')
  })

  it('commits nothing and audits nothing when the tag write fails', async () => {
    fake.state.failOn = 'tx.insert'

    await expect(
      updateArtifactWithTags({
        artifactId: ARTIFACT_ID,
        viewerRef: `user:${OWNER_ID}`,
        patch: {
          title: 'Should not stick',
          visibility: 'public',
          categoryIds: ['7f3e0000-0000-4000-8000-0000000000c3'],
        },
      }),
    ).rejects.toThrow('tx.insert failed')

    expect(stepNames()).not.toContain('db.commit')
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('leaves the tags alone when the patch has no categoryIds', async () => {
    const result = await updateArtifactWithTags({
      artifactId: ARTIFACT_ID,
      viewerRef: `user:${OWNER_ID}`,
      patch: { visibility: 'public' },
    })

    expect(stepNames()).not.toContain('tx.delete')
    expect(stepNames()).not.toContain('tx.insert')
    // A real visibility transition is still audited, after the commit.
    expect(stepNames().slice(-2)).toEqual(['db.commit', 'audit'])
    expect(result.tagsReplaced).toBe(false)
  })
})
