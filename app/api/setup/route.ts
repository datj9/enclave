import { credentialsSchema } from '@/lib/auth/credentials'
import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { createFirstAdmin, isSetupComplete } from '@/lib/auth/setup'
import { createSessionCookie } from '@/lib/auth/session'
import { recordAuditEvent } from '@/lib/audit'
import { HttpError, seeOther, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'

export const dynamic = 'force-dynamic'

const SETUP_ALREADY_DONE = 'Setup has already been completed'

export async function POST(request: Request): Promise<Response> {
  const returnsJson = wantsJsonResponse(request)

  try {
    enforceAuthRateLimit(request, 'setup')

    // Cheap pre-check for the common case. createFirstAdmin re-asserts it under a lock, which
    // is what actually makes two concurrent submits produce one admin and one 409.
    if (await isSetupComplete()) {
      throw new HttpError('VALIDATION_FAILED', SETUP_ALREADY_DONE, { status: 409 })
    }

    const parsed = credentialsSchema.safeParse(await readRequestBody(request))
    if (!parsed.success) {
      throw new HttpError(
        'VALIDATION_FAILED',
        'Enter a valid email and a password of at least 12 characters',
      )
    }

    const admin = await createFirstAdmin(parsed.data)
    recordAuditEvent({
      action: 'user.create',
      actorUserId: admin.id,
      actorIp: clientIpFromHeaders(request.headers),
      metadata: { role: 'admin', via: 'setup' },
    })

    const sessionCookie = await createSessionCookie(admin.id)
    return seeOther('/dashboard', { 'set-cookie': sessionCookie })
  } catch (error) {
    if (returnsJson) return toErrorResponse(error)

    const isAlreadyDone = error instanceof HttpError && error.message === SETUP_ALREADY_DONE
    return seeOther(isAlreadyDone ? '/signin' : '/setup?error=invalid')
  }
}
