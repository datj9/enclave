import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { normaliseHost } from '../../push-core/src/index.ts'

export interface HostCredential {
  readonly token: string
}

export class CredentialError extends Error {}

export function credentialsPath(): string {
  const base = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
  return join(base, 'enclave', 'credentials.json')
}

function assertShape(path: string, parsed: unknown): asserts parsed is Record<string, HostCredential> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CredentialError(`${path} does not contain a credentials object — remove it and log in again`)
  }
  for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || typeof (value as { token?: unknown }).token !== 'string') {
      throw new CredentialError(
        `${path} has a malformed entry for '${host}' — remove it and log in again`,
      )
    }
  }
}

export function readCredentials(): Record<string, HostCredential> {
  const path = credentialsPath()
  if (!existsSync(path)) return {}

  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    throw new CredentialError(
      `${path} could not be inspected (${code}) — check its permissions and ownership`,
    )
  }

  if (!stat.isFile()) {
    throw new CredentialError(`${path} is not a regular file — remove it and log in again`)
  }

  if (stat.mode & 0o077) {
    throw new CredentialError(`${path} is readable by other users. Run: chmod 600 ${path}`)
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown'
    throw new CredentialError(
      `${path} could not be read (${code}) — check its permissions and ownership`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new CredentialError(`${path} is not valid JSON — remove it and log in again`)
  }
  assertShape(path, parsed)
  return parsed
}

/**
 * A stored key only matches if it canonicalises to the same origin as `host` — a bare legacy key
 * (minted back when the CLI always forced https for a non-loopback host) canonicalises to https,
 * so it can never satisfy an http lookup and hand a token to an origin over cleartext.
 */
function storedKeyFor(store: Record<string, HostCredential>, host: string): string | null {
  if (store[host] !== undefined) return host
  for (const key of Object.keys(store)) {
    try {
      if (normaliseHost(key) === host) return key
    } catch {
      continue
    }
  }
  return null
}

export function tokenFor(host: string): string | null {
  // Trimmed, so this agrees with `login`'s own "was a token entered?" test. Untrimmed, a trailing
  // space in a .env file sends `Bearer    ` and silently bypasses a good stored credential.
  const fromEnvironment = process.env['ENCLAVE_TOKEN']?.trim()
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    // Warn when the env token silently shadows a different stored credential.
    try {
      const store = readCredentials()
      const key = storedKeyFor(store, host)
      if (key !== null && store[key]?.token !== fromEnvironment) {
        process.stderr.write(
          `enclave: ENCLAVE_TOKEN is overriding the stored credential for ${host}\n`,
        )
      }
    } catch {
      // A broken credential store cannot invalidate a working environment token.
    }
    return fromEnvironment
  }
  const store = readCredentials()
  const key = storedKeyFor(store, host)
  return key === null ? null : (store[key]?.token ?? null)
}

export function saveToken(host: string, token: string): void {
  const path = credentialsPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next = { ...readCredentials(), [host]: { token } }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Deletes the canonical key AND every legacy key that canonicalises to the same origin, so
 *  logout fully revokes rather than leaving a second live credential behind. */
export function forgetToken(host: string): boolean {
  const current = readCredentials()
  const matchingKeys = Object.keys(current).filter((key) => {
    if (key === host) return true
    try {
      return normaliseHost(key) === host
    } catch {
      return false
    }
  })
  if (matchingKeys.length === 0) return false

  const next = { ...current }
  for (const key of matchingKeys) delete next[key]
  writeFileSync(credentialsPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return true
}
