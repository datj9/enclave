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

function assertPrivate(path: string): void {
  const mode = statSync(path).mode & 0o077
  if (mode !== 0) {
    throw new CredentialError(`${path} is readable by other users. Run: chmod 600 ${path}`)
  }
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
  assertPrivate(path)

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
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
  const fromEnvironment = process.env['ENCLAVE_TOKEN']
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
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
