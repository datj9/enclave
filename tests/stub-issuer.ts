import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'

/**
 * An in-process OpenID Provider. The OIDC specs are exercised against this rather than a real
 * identity provider so the suite stays hermetic and offline.
 *
 * It implements only what the authorization-code + PKCE flow touches: discovery, JWKS and the
 * token endpoint. The authorization endpoint is advertised but never called — tests hold the
 * browser's half of the flow themselves via `issueCode`.
 */

const SIGNING_ALGORITHM = 'RS256'

export interface IssuedCodeOptions {
  readonly subject: string
  readonly email: string
  readonly codeChallenge: string
  /** Omit to mint an ID token with no `nonce` claim at all. */
  readonly nonce?: string
  readonly emailVerified?: boolean
  /** Negative values mint an already-expired ID token. */
  readonly expiresInSeconds?: number
}

export interface StubIssuer {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecret: string
  issueCode(options: IssuedCodeOptions): string
  close(): Promise<void>
}

interface PendingAuthorization extends IssuedCodeOptions {
  readonly code: string
}

function pkceChallengeOf(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json;charset=UTF-8' })
  response.end(payload)
}

async function readBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: [SIGNING_ALGORITHM],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    scopes_supported: ['openid', 'email', 'profile'],
    claims_supported: ['sub', 'email', 'email_verified'],
  }
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo | null
  if (address === null) throw new Error('the stub issuer did not bind a port')
  return address.port
}

export async function startStubIssuer(clientId: string, clientSecret: string): Promise<StubIssuer> {
  const { publicKey, privateKey } = await generateKeyPair(SIGNING_ALGORITHM, {
    extractable: true,
  })
  const publicJwk = { ...(await exportJWK(publicKey)), alg: SIGNING_ALGORITHM, use: 'sig' }

  const pendingByCode = new Map<string, PendingAuthorization>()
  let issuer = ''
  let nextCodeNumber = 0

  async function mintIdToken(pending: PendingAuthorization): Promise<string> {
    const claims: Record<string, unknown> = {
      email: pending.email,
      email_verified: pending.emailVerified ?? true,
    }
    if (pending.nonce !== undefined) claims.nonce = pending.nonce

    const issuedAt = Math.floor(Date.now() / 1000)
    return new SignJWT(claims)
      .setProtectedHeader({ alg: SIGNING_ALGORITHM })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(pending.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (pending.expiresInSeconds ?? 300))
      .sign(privateKey)
  }

  async function handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request)
    const pending = pendingByCode.get(body.get('code') ?? '')

    if (pending === undefined) {
      sendJson(response, 400, { error: 'invalid_grant' })
      return
    }
    if (body.get('client_id') !== clientId || body.get('client_secret') !== clientSecret) {
      sendJson(response, 401, { error: 'invalid_client' })
      return
    }

    const codeVerifier = body.get('code_verifier') ?? ''
    if (pkceChallengeOf(codeVerifier) !== pending.codeChallenge) {
      sendJson(response, 400, { error: 'invalid_grant' })
      return
    }

    pendingByCode.delete(pending.code)
    sendJson(response, 200, {
      access_token: `stub-access-${pending.code}`,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: await mintIdToken(pending),
    })
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', issuer).pathname

    if (path === '/.well-known/openid-configuration') {
      sendJson(response, 200, discoveryDocument(issuer))
      return
    }
    if (path === '/jwks') {
      sendJson(response, 200, { keys: [publicJwk] })
      return
    }
    if (path === '/token' && request.method === 'POST') {
      void handleToken(request, response).catch(() => {
        sendJson(response, 500, { error: 'server_error' })
      })
      return
    }
    sendJson(response, 404, { error: 'not_found' })
  })

  issuer = `http://127.0.0.1:${await listenOnLoopback(server)}`

  return {
    issuer,
    clientId,
    clientSecret,
    issueCode(options) {
      nextCodeNumber += 1
      const code = `stub-code-${nextCodeNumber}`
      pendingByCode.set(code, { ...options, code })
      return code
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}

/** The `code_challenge` the app put on the authorization URL, recovered for `issueCode`. */
export function codeChallengeFrom(authorizationUrl: string): string {
  const challenge = new URL(authorizationUrl).searchParams.get('code_challenge')
  if (challenge === null) throw new Error('the authorization URL carried no code_challenge')
  return challenge
}
