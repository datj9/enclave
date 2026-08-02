import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

export function readCredentials(): Record<string, HostCredential> {
  const path = credentialsPath()
  if (!existsSync(path)) return {}
  assertPrivate(path)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, HostCredential>
}

export function tokenFor(host: string): string | null {
  const fromEnvironment = process.env['ENCLAVE_TOKEN']
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
  return readCredentials()[host]?.token ?? null
}

export function saveToken(host: string, token: string): void {
  const path = credentialsPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const next = { ...readCredentials(), [host]: { token } }
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function forgetToken(host: string): boolean {
  const current = readCredentials()
  if (current[host] === undefined) return false
  const next = { ...current }
  delete next[host]
  writeFileSync(credentialsPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return true
}
