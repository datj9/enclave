import { forgetToken } from '../credentials.ts'

export function runLogout(host: string): number {
  if (forgetToken(host)) {
    process.stdout.write(`✓ forgot ${host}\n`)
    return 0
  }
  process.stdout.write(`no credential for ${host}\n`)
  return 0
}
