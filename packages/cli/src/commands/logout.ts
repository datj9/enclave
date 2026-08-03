import { CredentialError, forgetToken } from '../credentials.ts'

export function runLogout(host: string): number {
  try {
    if (forgetToken(host)) {
      process.stdout.write(`✓ forgot ${host}\n`)
      return 0
    }
  } catch (error) {
    const message = error instanceof CredentialError ? error.message : messageOf(error)
    process.stderr.write(`${message}\n`)
    return 1
  }
  process.stderr.write(`no credential for ${host}\n`)
  return 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
