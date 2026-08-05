import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ApiClientModule from './src/api-client.ts'

import { ApiError } from './src/api-client.ts'
import { runShareCreate, runShareList, runShareRevoke } from './src/commands/shares.ts'

const mocks = vi.hoisted(() => ({
  apiClient: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  remove: vi.fn(),
}))

// Only the factory is replaced: `ApiError` stays the real class, so `instanceof` still narrows.
vi.mock('./src/api-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>()
  return { ...actual, apiClient: mocks.apiClient }
})

const HOST = 'artifacts.example.com'
const TOKEN = 'ent_test_token'
const ARTIFACT_ID = '3f2a91c4-2f1e-4a0b-9d43-5c9d0f0a1b2c'
const VERSION_ID = '8b1d0e77-1c22-4b6a-9f3e-0a5d7c2e4f10'
const SHARE_ID = 'c0ffee11-2b3c-4d5e-8f90-a1b2c3d4e5f6'
const SHARE_URL = 'https://artifacts.example.com/s/pl41nt3xt-t0k3n'
const NOW = new Date('2026-08-02T00:00:00.000Z')

interface RequestBody {
  readonly versionId?: string
  readonly expiresAt?: string
}

describe('share commands', () => {
  let configHome = ''
  let originalConfigHome: string | undefined
  let originalToken: string | undefined
  let stdout: string[] = []
  let stderr: string[] = []

  function capture(stream: NodeJS.WriteStream, sink: string[]): void {
    vi.spyOn(stream, 'write').mockImplementation((chunk: unknown): boolean => {
      sink.push(String(chunk))
      return true
    })
  }

  function outputText(): string {
    return stdout.join('')
  }

  function errorText(): string {
    return stderr.join('')
  }

  function postCall(): { path: string; body: RequestBody } {
    const call = mocks.post.mock.calls[0]
    if (call === undefined) throw new Error('post was never called')
    return { path: String(call[0]), body: call[1] as RequestBody }
  }

  beforeEach(() => {
    originalConfigHome = process.env['XDG_CONFIG_HOME']
    originalToken = process.env['ENCLAVE_TOKEN']
    configHome = mkdtempSync(join(tmpdir(), 'enclave-shares-'))
    process.env['XDG_CONFIG_HOME'] = configHome
    process.env['ENCLAVE_TOKEN'] = TOKEN

    vi.useFakeTimers()
    vi.setSystemTime(NOW)

    stdout = []
    stderr = []
    capture(process.stdout, stdout)
    capture(process.stderr, stderr)

    mocks.apiClient.mockReturnValue({
      get: mocks.get,
      post: mocks.post,
      patch: mocks.patch,
      remove: mocks.remove,
    })
    mocks.post.mockResolvedValue({
      shareId: SHARE_ID,
      token: 'plaintext',
      url: SHARE_URL,
      versionId: VERSION_ID,
    })
    mocks.get.mockResolvedValue({ items: [] })
    mocks.remove.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    mocks.apiClient.mockReset()
    mocks.get.mockReset()
    mocks.post.mockReset()
    mocks.patch.mockReset()
    mocks.remove.mockReset()

    if (originalConfigHome === undefined) delete process.env['XDG_CONFIG_HOME']
    else process.env['XDG_CONFIG_HOME'] = originalConfigHome
    if (originalToken === undefined) delete process.env['ENCLAVE_TOKEN']
    else process.env['ENCLAVE_TOKEN'] = originalToken

    rmSync(configHome, { recursive: true, force: true })
  })

  // AC 1 — `share create` prints a URL that resolves for a signed-out client.
  describe('share create prints the url once (AC 1)', () => {
    it('posts to the artifact shares route with the pinned version', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        isJson: false,
      })

      expect(code).toBe(0)
      expect(mocks.apiClient).toHaveBeenCalledWith(HOST, TOKEN, false)
      expect(postCall().path).toBe(`/api/v1/artifacts/${ARTIFACT_ID}/shares`)
      expect(postCall().body).toEqual({ versionId: VERSION_ID })
    })

    it('passes the insecure-host opt-in through to the api client', async () => {
      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        isJson: false,
        isInsecureAllowed: true,
      })

      expect(mocks.apiClient).toHaveBeenCalledWith(HOST, TOKEN, true)
    })

    it('prints the url exactly once and says it is shown only once', async () => {
      await runShareCreate({ host: HOST, id: ARTIFACT_ID, versionId: VERSION_ID, isJson: false })

      expect(outputText().split(SHARE_URL)).toHaveLength(2)
      expect(outputText()).toContain('shown once')
      expect(outputText()).toContain(SHARE_ID)
    })

    it('emits only valid json under --json, still carrying the url once', async () => {
      await runShareCreate({ host: HOST, id: ARTIFACT_ID, versionId: VERSION_ID, isJson: true })

      const parsed: unknown = JSON.parse(outputText())
      expect(parsed).toEqual({
        shareId: SHARE_ID,
        url: SHARE_URL,
        expiresAt: null,
        versionId: VERSION_ID,
      })
      expect(errorText()).toContain('shown once')
    })

    it('omits versionId so the server can default to the current ready version', async () => {
      const code = await runShareCreate({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(0)
      expect(postCall().body).toEqual({})
      expect(outputText()).toContain(VERSION_ID)
    })
  })

  // AC 2 — `--expires 7d` is converted to an absolute ISO timestamp before sending.
  describe('relative expiry becomes an absolute timestamp (AC 2)', () => {
    it('converts 7d against the current clock', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '7d',
        isJson: false,
      })

      expect(code).toBe(0)
      expect(postCall().body).toEqual({
        versionId: VERSION_ID,
        expiresAt: '2026-08-09T00:00:00.000Z',
      })
    })

    it('converts an hour suffix', async () => {
      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '12h',
        isJson: false,
      })

      expect(postCall().body.expiresAt).toBe('2026-08-02T12:00:00.000Z')
    })

    it('refuses a duration that overflows the Date range instead of sending an invalid instant', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '999999999999w',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(errorText()).toContain('is out of range')
      expect(mocks.post).not.toHaveBeenCalled()
    })

    it('sends a Zulu instant through unchanged', async () => {
      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-09-01T08:30:00.000Z',
        isJson: false,
      })

      expect(postCall().body.expiresAt).toBe('2026-09-01T08:30:00.000Z')
    })

    it('rejects engine-lenient calendar overflow such as 2027-02-30', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2027-02-30',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(errorText()).toContain('a duration like 7d, 12h or 2w')
      expect(mocks.post).not.toHaveBeenCalled()
    })

    it('rejects legacy Date strings that are not documented', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: 'Dec 25 2027',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(mocks.post).not.toHaveBeenCalled()
    })

    it('reports the absolute expiry it sent', async () => {
      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '7d',
        isJson: true,
      })

      expect(JSON.parse(outputText())).toMatchObject({ expiresAt: '2026-08-09T00:00:00.000Z' })
    })
  })

  // The owner's decision on the timezone defect: a bare date and a zone-less date-time both now
  // resolve in the operator's local zone, so the same typed shape never means two different
  // instants depending on whether it carries a time-of-day.
  describe('expiry normalises in the operator local zone, not UTC', () => {
    let originalTz: string | undefined

    beforeEach(() => {
      originalTz = process.env['TZ']
      // Asia/Jakarta has no DST and a non-zero, non-UTC offset year-round, so a test pinned to it
      // cannot pass by accident on a host that happens to already be in UTC.
      process.env['TZ'] = 'Asia/Jakarta'
    })

    afterEach(() => {
      if (originalTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = originalTz
    })

    it('resolves a bare date to the end of that day in the local zone, not UTC midnight', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10',
        isJson: false,
      })

      expect(code).toBe(0)
      expect(postCall().body.expiresAt).toBe('2026-08-10T16:59:59.999Z')
    })

    it('resolves a zone-less date-time to that wall-clock time in the local zone', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10T14:30',
        isJson: false,
      })

      expect(code).toBe(0)
      expect(postCall().body.expiresAt).toBe('2026-08-10T07:30:00.000Z')
    })

    it('still resolves a zoned instant exactly as given, regardless of the local zone', async () => {
      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10T09:00:00+07:00',
        isJson: false,
      })

      expect(postCall().body.expiresAt).toBe('2026-08-10T02:00:00.000Z')
    })

    it('prints both frames to stderr before the POST', async () => {
      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10',
        isJson: false,
      })

      expect(errorText()).toContain(
        'expires 2026-08-10T16:59:59.999Z (10 Aug 2026, 23:59:59 local, Asia/Jakarta)',
      )
    })

    // Reading stderr from inside the request itself is the only assertion that survives the
    // disclosure being moved below `client.post`, where the operator would learn the instant only
    // after the link already exists.
    it('writes the disclosure before the request, and keeps --json stdout parseable', async () => {
      let disclosureAtRequest = ''
      mocks.post.mockImplementation(() => {
        disclosureAtRequest = errorText()
        return Promise.resolve({
          shareId: SHARE_ID,
          token: 'plaintext',
          url: SHARE_URL,
          versionId: VERSION_ID,
        })
      })

      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10',
        isJson: true,
      })

      expect(disclosureAtRequest).toContain(
        'expires 2026-08-10T16:59:59.999Z (10 Aug 2026, 23:59:59 local, Asia/Jakarta)',
      )
      expect(JSON.parse(outputText())).toMatchObject({ expiresAt: '2026-08-10T16:59:59.999Z' })
    })

    it('writes the disclosure even when the POST itself is later rejected', async () => {
      mocks.post.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Token lacks scope shares:write'))

      await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10',
        isJson: false,
      })

      expect(errorText()).toContain('expires 2026-08-10T16:59:59.999Z')
    })

    it('does not print the disclosure when --expires is omitted', async () => {
      await runShareCreate({ host: HOST, id: ARTIFACT_ID, versionId: VERSION_ID, isJson: false })

      expect(errorText()).not.toContain('expires ')
    })

    it('accepts a six-digit fractional second on a zoned instant (matches the API)', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10T09:00:00.123456Z',
        isJson: false,
      })

      expect(code).toBe(0)
      expect(postCall().body.expiresAt).toBe('2026-08-10T09:00:00.123Z')
    })

    it('accepts lowercase z as an explicit zone (RFC 3339 §5.6)', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10T09:00:00z',
        isJson: false,
      })

      expect(code).toBe(0)
      expect(postCall().body.expiresAt).toBe('2026-08-10T09:00:00.000Z')
    })

    it('rejects a calendar-overflow date-only value after local round-trip', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2027-02-30',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(errorText()).toContain('a duration like 7d, 12h or 2w')
      expect(errorText()).toContain('a date like 2026-08-10')
      expect(errorText()).toContain('a date-time like 2026-08-10T14:30')
      expect(errorText()).toContain('ISO-8601')
      expect(mocks.post).not.toHaveBeenCalled()
    })
  })

  // West of UTC the local calendar day can differ from the UTC day — the disclosure must name
  // the local date, not only the wall-clock time.
  describe('expiry disclosure in a negative-offset zone', () => {
    let originalTz: string | undefined

    beforeEach(() => {
      originalTz = process.env['TZ']
      process.env['TZ'] = 'America/Los_Angeles'
    })

    afterEach(() => {
      if (originalTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = originalTz
    })

    it('resolves a bare date to local end-of-day and prints the local calendar date', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2026-08-10',
        isJson: false,
      })

      expect(code).toBe(0)
      expect(postCall().body.expiresAt).toBe('2026-08-11T06:59:59.999Z')
      expect(errorText()).toContain(
        'expires 2026-08-11T06:59:59.999Z (10 Aug 2026, 23:59:59 local, America/Los_Angeles)',
      )
    })
  })

  // AC 3 — an already-past `--expires` is refused client-side with exit 2, before any HTTP call.
  describe('a past expiry is refused client-side (AC 3)', () => {
    it('exits 2 and makes no request for a past timestamp', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '2020-01-01T00:00:00.000Z',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(errorText()).toContain('not in the future')
      expect(mocks.post).not.toHaveBeenCalled()
      expect(mocks.get).not.toHaveBeenCalled()
    })

    it('exits 2 for a zero-length duration', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: '0d',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(mocks.post).not.toHaveBeenCalled()
    })

    it('exits 2 for an unparseable expiry', async () => {
      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        expires: 'next tuesday',
        isJson: false,
      })

      expect(code).toBe(2)
      expect(errorText()).toContain('ISO-8601')
      expect(mocks.post).not.toHaveBeenCalled()
    })
  })

  // AC 4 — `share list` shows id, pinned version, expiry and revoked state, and never a token.
  describe('share list (AC 4)', () => {
    const items = [
      {
        shareId: SHARE_ID,
        versionId: VERSION_ID,
        expiresAt: '2026-08-09T00:00:00.000Z',
        revokedAt: null,
        // A field the CLI must never surface even if the server started sending it.
        token: 'must-never-be-printed',
      },
      {
        shareId: 'aa11bb22-3344-4556-8778-99aabbccddee',
        versionId: VERSION_ID,
        expiresAt: null,
        revokedAt: '2026-07-30T09:00:00.000Z',
      },
    ]

    it('gets the artifact shares route', async () => {
      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(0)
      expect(mocks.get).toHaveBeenCalledWith(`/api/v1/artifacts/${ARTIFACT_ID}/shares`)
    })

    it('shows id, pinned version, expiry and state', async () => {
      mocks.get.mockResolvedValue({ items })

      await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(outputText()).toContain('c0ffee11')
      expect(outputText()).toContain('8b1d0e77')
      expect(outputText()).toContain('2026-08-09T00:00:00.000Z')
      expect(outputText()).toContain('active')
      expect(outputText()).toContain('revoked')
      expect(outputText()).toContain('never')
    })

    it('never prints a token, in either format', async () => {
      mocks.get.mockResolvedValue({ items })

      await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })
      await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: true })

      expect(outputText()).not.toContain('must-never-be-printed')
      expect(outputText()).not.toContain('token')
    })

    // Also exercises the databaseNow-absent fallback: this payload never sets it.
    it('marks a lapsed expiry as expired', async () => {
      mocks.get.mockResolvedValue({
        items: [
          {
            shareId: SHARE_ID,
            versionId: VERSION_ID,
            expiresAt: '2026-07-01T00:00:00.000Z',
            revokedAt: null,
          },
        ],
      })

      await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: true })

      expect(JSON.parse(outputText())).toEqual([
        {
          shareId: SHARE_ID,
          versionId: VERSION_ID,
          expiresAt: '2026-07-01T00:00:00.000Z',
          state: 'expired',
        },
      ])
    })

    it('says so when there are none', async () => {
      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(0)
      expect(outputText()).toBe('no share links\n')
    })

    // STATE is judged on the server's clock, mirroring the invariant the API gate itself follows
    // (src/lib/shares/clock.ts) — never the operator's laptop clock, which can be skewed.
    it('derives STATE from the server clock the API returns, not the laptop clock', async () => {
      mocks.get.mockResolvedValue({
        items: [
          {
            shareId: SHARE_ID,
            versionId: VERSION_ID,
            // Equal to the laptop clock (NOW): the old `<= laptop now` rule would call this
            // expired, but the server clock below is a minute earlier — still active.
            expiresAt: NOW.toISOString(),
            revokedAt: null,
          },
        ],
        databaseNow: '2026-08-01T23:59:00.000Z',
      })

      await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: true })

      expect(JSON.parse(outputText())).toEqual([
        {
          shareId: SHARE_ID,
          versionId: VERSION_ID,
          expiresAt: NOW.toISOString(),
          state: 'active',
        },
      ])
    })

    it('falls back to the laptop clock when databaseNow is unparseable', async () => {
      mocks.get.mockResolvedValue({
        items: [
          {
            shareId: SHARE_ID,
            versionId: VERSION_ID,
            expiresAt: '2026-07-01T00:00:00.000Z',
            revokedAt: null,
          },
        ],
        databaseNow: 'not-a-timestamp',
      })

      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: true })

      expect(code).toBe(0)
      expect(JSON.parse(outputText())).toEqual([
        {
          shareId: SHARE_ID,
          versionId: VERSION_ID,
          expiresAt: '2026-07-01T00:00:00.000Z',
          state: 'expired',
        },
      ])
    })
  })

  // AC 5 — `share revoke` makes the URL 404 on the next request.
  describe('share revoke (AC 5)', () => {
    it('deletes the share resource', async () => {
      const code = await runShareRevoke({ host: HOST, shareId: SHARE_ID })

      expect(code).toBe(0)
      expect(mocks.remove).toHaveBeenCalledWith(`/api/v1/shares/${SHARE_ID}`)
      expect(mocks.post).not.toHaveBeenCalled()
      expect(outputText()).toContain('revoked c0ffee11')
    })

    it('refuses a malformed share id before any request', async () => {
      const code = await runShareRevoke({ host: HOST, shareId: 'not-a-uuid' })

      expect(code).toBe(2)
      expect(mocks.remove).not.toHaveBeenCalled()
    })
  })

  // AC 6 — a token without `shares:write` is rejected and the CLI names the missing scope.
  describe('a missing scope is named (AC 6)', () => {
    it('names the scope on the 403 the server actually sends', async () => {
      mocks.post.mockRejectedValue(new ApiError(403, 'FORBIDDEN', 'Token lacks scope shares:write'))

      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        isJson: false,
      })

      expect(code).toBe(1)
      expect(errorText()).toContain('shares:write')
    })

    it('names the scope on a 401 too', async () => {
      mocks.get.mockRejectedValue(
        new ApiError(401, 'UNAUTHENTICATED', 'The API token is not valid'),
      )

      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(1)
      expect(errorText()).toContain('shares:write')
    })

    it('does not confuse an ownership 403 with a scope problem', async () => {
      mocks.remove.mockRejectedValue(
        new ApiError(403, 'FORBIDDEN', 'Only the owner can change this artifact'),
      )

      const code = await runShareRevoke({ host: HOST, shareId: SHARE_ID })

      expect(code).toBe(1)
      expect(errorText()).toContain('another account')
      expect(errorText()).not.toContain('shares:write')
    })

    it('exits 1 when no token is stored for the host', async () => {
      delete process.env['ENCLAVE_TOKEN']

      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(1)
      expect(errorText()).toContain('enclave login')
      expect(mocks.get).not.toHaveBeenCalled()
    })

    it('exits 1 on an empty stored token rather than sending a bare bearer header', async () => {
      // `artifacts.ts` already rejected this locally; sending it puts an empty credential on the
      // wire and answers with the server's scope error, which the user cannot act on.
      process.env['ENCLAVE_TOKEN'] = ''

      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(1)
      expect(errorText()).toContain('enclave login')
      expect(mocks.get).not.toHaveBeenCalled()
    })
  })

  // AC 7 — `create` against another user's artifact returns 404.
  describe("another user's artifact is a 404 (AC 7)", () => {
    it('prints "not found" and never "forbidden"', async () => {
      mocks.post.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'No such artifact'))

      const code = await runShareCreate({
        host: HOST,
        id: ARTIFACT_ID,
        versionId: VERSION_ID,
        isJson: false,
      })

      expect(code).toBe(1)
      expect(errorText()).toContain('not found')
      expect(errorText().toLowerCase()).not.toContain('forbidden')
    })

    it('is a 404 on list as well', async () => {
      mocks.get.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'No such artifact'))

      const code = await runShareList({ host: HOST, id: ARTIFACT_ID, isJson: false })

      expect(code).toBe(1)
      expect(errorText()).toContain('not found')
      expect(errorText().toLowerCase()).not.toContain('forbidden')
    })
  })
})
