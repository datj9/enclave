import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { users, type UserRole } from '@/db/schema'
import { env } from '@/env'
import { isSessionInvalidatedByPasswordChange } from './session-freshness'

export const SESSION_COOKIE_NAME = 'enclave_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7

const SESSION_ISSUER = 'enclave'
const SESSION_AUDIENCE = 'enclave-app'

export interface SessionUser {
  readonly id: string
  readonly email: string
  readonly role: UserRole
  readonly isActive: boolean
}

function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.SESSION_SECRET)
}

async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey())
}

/**
 * Deliberately no `Domain` attribute: a host-only cookie. With artifacts served from
 * `{id}.artifacts.<domain>`, a `Domain=<domain>` cookie would be readable by every artifact's
 * JavaScript (grill-result §4.1, §8). Do not add one.
 */
function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  } as const
}

/** Returns the `Set-Cookie` value for route handlers that build a raw Response. */
export async function createSessionCookie(userId: string): Promise<string> {
  const token = await signSessionToken(userId)
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ]
  return attributes.join('; ')
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

/** For server components and actions, which can write to the cookie store directly. */
export async function setSessionCookie(userId: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(
    SESSION_COOKIE_NAME,
    await signSessionToken(userId),
    cookieOptions(SESSION_TTL_SECONDS),
  )
}

interface VerifiedSessionToken {
  readonly userId: string
  readonly issuedAtSeconds: number | undefined
}

async function verifySessionToken(token: string): Promise<VerifiedSessionToken | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ['HS256'],
    })
    if (typeof payload.sub !== 'string') return null
    return { userId: payload.sub, issuedAtSeconds: payload.iat }
  } catch {
    return null
  }
}

/**
 * Re-reads the user on every call rather than trusting claims in the token. That is what makes
 * a session server-side revocable: deactivating a user 401s their next request (§7), and so does
 * a password change, via `password_changed_at` vs the token's `iat`.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (token === undefined) return null

  const verified = await verifySessionToken(token)
  if (verified === null) return null

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(users)
    .where(eq(users.id, verified.userId))
    .limit(1)

  if (user === undefined || !user.isActive) return null
  if (isSessionInvalidatedByPasswordChange(user.passwordChangedAt, verified.issuedAtSeconds)) {
    return null
  }
  return { id: user.id, email: user.email, role: user.role, isActive: user.isActive }
}
