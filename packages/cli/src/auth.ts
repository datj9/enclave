import { apiClient, type ApiClient } from './api-client.ts'
import { tokenFor } from './credentials.ts'
import { CliError } from './errors.ts'
import type { CliContext } from './output.ts'

/**
 * An empty stored token is not a credential. Sending `Authorization: Bearer ` puts it on the wire
 * and surfaces the server's scope error instead of the local one the user can act on.
 */
export function requireToken(host: string, ctx: CliContext): string {
  const token = tokenFor(host, ctx)
  if (token === null || token === '') {
    throw new CliError(
      'NOT_AUTHENTICATED',
      `not logged in to ${host} — run: enclave login --host ${host}`,
    )
  }
  return token
}

/** The one way a command gets an authenticated client: every command refuses the same way. */
export function requireClient(host: string, ctx: CliContext, isInsecureAllowed = false): ApiClient {
  return apiClient(host, requireToken(host, ctx), isInsecureAllowed)
}
