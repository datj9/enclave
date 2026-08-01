import { describe, expect, it } from 'vitest'

import {
  canRead,
  type ReadableArtifact,
  type ReadableVersion,
  type Viewer,
} from '@/lib/artifacts/can-read'

/**
 * grill-result §5.1, branch by branch. This gate decides every read in the product, so it is
 * held to 100% branch coverage — the table below exists to make each branch fail loudly on its
 * own rather than as part of some larger flow.
 */

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const CAROL = 'cccccccc-3333-4333-8333-cccccccccccc'
const ARTIFACT_ID = '11111111-4444-4444-8444-111111111111'
const OTHER_ARTIFACT_ID = '22222222-5555-4555-8555-222222222222'
const VERSION_ID = '33333333-6666-4666-8666-333333333333'

function artifact(overrides: Partial<ReadableArtifact> = {}): ReadableArtifact {
  return {
    id: ARTIFACT_ID,
    ownerId: ALICE,
    visibility: 'private',
    deletedAt: null,
    ...overrides,
  }
}

const VERSION: ReadableVersion = { id: VERSION_ID, artifactId: ARTIFACT_ID }

function user(id: string, overrides: { role?: 'admin' | 'member'; isActive?: boolean } = {}): Viewer {
  return { kind: 'user', id, role: overrides.role ?? 'member', isActive: overrides.isActive ?? true }
}

const OWNER_SESSION = user(ALICE)
const OWNER_TOKEN: Viewer = { kind: 'apiToken', userId: ALICE }
const STRANGER_SESSION = user(BOB)
const STRANGER_TOKEN: Viewer = { kind: 'apiToken', userId: BOB }
const ADMIN_SESSION = user(CAROL, { role: 'admin' })
const SHARE_TOKEN: Viewer = { kind: 'shareToken', shareLinkId: 'link-1' }

interface Case {
  readonly name: string
  readonly viewer: Viewer
  readonly artifact: ReadableArtifact
  readonly version: ReadableVersion
  readonly expected: boolean
}

const CASES: readonly Case[] = [
  {
    name: 'precondition — a version belonging to another artifact is refused, even for the owner',
    viewer: OWNER_SESSION,
    artifact: artifact(),
    version: { id: VERSION_ID, artifactId: OTHER_ARTIFACT_ID },
    expected: false,
  },
  {
    name: 'branch 1 — a deleted artifact is unreadable by its own owner',
    viewer: OWNER_SESSION,
    artifact: artifact({ deletedAt: new Date('2026-01-01T00:00:00Z') }),
    version: VERSION,
    expected: false,
  },
  {
    name: 'branch 1 — a deleted org artifact is unreadable by anyone else',
    viewer: STRANGER_SESSION,
    artifact: artifact({ visibility: 'org', deletedAt: new Date('2026-01-01T00:00:00Z') }),
    version: VERSION,
    expected: false,
  },
  {
    name: 'branch 2 — the owner reads their own private artifact',
    viewer: OWNER_SESSION,
    artifact: artifact(),
    version: VERSION,
    expected: true,
  },
  {
    name: "branch 2 — the owner's API token reads their own private artifact",
    viewer: OWNER_TOKEN,
    artifact: artifact(),
    version: VERSION,
    expected: true,
  },
  {
    name: 'branch 3 — a signed-in member reads an org artifact they do not own',
    viewer: STRANGER_SESSION,
    artifact: artifact({ visibility: 'org' }),
    version: VERSION,
    expected: true,
  },
  {
    name: 'branch 3 — an admin reads an org artifact, like any other member',
    viewer: ADMIN_SESSION,
    artifact: artifact({ visibility: 'org' }),
    version: VERSION,
    expected: true,
  },
  {
    name: 'branch 3 — a deactivated member reads nothing, org or not',
    viewer: user(BOB, { isActive: false }),
    artifact: artifact({ visibility: 'org' }),
    version: VERSION,
    expected: false,
  },
  {
    name: "branch 3 — someone else's API token stays owner-scoped on an org artifact",
    viewer: STRANGER_TOKEN,
    artifact: artifact({ visibility: 'org' }),
    version: VERSION,
    expected: false,
  },
  {
    name: 'branch 4 — a share token reads nothing until S5 lands (private)',
    viewer: SHARE_TOKEN,
    artifact: artifact(),
    version: VERSION,
    expected: false,
  },
  {
    name: 'branch 4 — a share token reads nothing until S5 lands (org)',
    viewer: SHARE_TOKEN,
    artifact: artifact({ visibility: 'org' }),
    version: VERSION,
    expected: false,
  },
  {
    name: "branch 5 — an admin cannot read someone else's private artifact",
    viewer: ADMIN_SESSION,
    artifact: artifact(),
    version: VERSION,
    expected: false,
  },
  {
    name: 'branch 5 — a deactivated admin cannot either',
    viewer: user(CAROL, { role: 'admin', isActive: false }),
    artifact: artifact(),
    version: VERSION,
    expected: false,
  },
  {
    name: 'branch 6 — a member cannot read a private artifact they do not own',
    viewer: STRANGER_SESSION,
    artifact: artifact(),
    version: VERSION,
    expected: false,
  },
  {
    name: "branch 6 — an API token cannot read another user's private artifact",
    viewer: STRANGER_TOKEN,
    artifact: artifact(),
    version: VERSION,
    expected: false,
  },
]

describe('canRead', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      expect(canRead(testCase.viewer, testCase.artifact, testCase.version)).toBe(testCase.expected)
    },
  )
})

describe('canRead — the promise the product makes', () => {
  it('never lets an admin read a private artifact, whoever owns it', () => {
    for (const ownerId of [ALICE, BOB, CAROL]) {
      const readable = canRead(ADMIN_SESSION, artifact({ ownerId }), VERSION)
      // Carol owns the third one, so branch 2 is why that single case is true.
      expect(readable).toBe(ownerId === CAROL)
    }
  })

  it('refuses every viewer kind once the artifact is in the trash', () => {
    const deleted = artifact({ visibility: 'org', deletedAt: new Date('2026-01-01T00:00:00Z') })
    const viewers: readonly Viewer[] = [
      OWNER_SESSION,
      OWNER_TOKEN,
      STRANGER_SESSION,
      STRANGER_TOKEN,
      ADMIN_SESSION,
      SHARE_TOKEN,
    ]

    expect(viewers.map((viewer) => canRead(viewer, deleted, VERSION))).toEqual(
      viewers.map(() => false),
    )
  })
})
