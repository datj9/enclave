import type { z } from 'zod'

import {
  auditPasswordChangeFailure,
  changePassword,
  changePasswordSchema,
  PasswordChangeError,
  type PasswordChangeFailureKind,
} from '@/lib/auth/change-password'
import {
  enforceAuthRateLimit,
  enforceChangePasswordUserRateLimit,
} from '@/lib/auth/rate-limit-auth'
import { createSessionCookie } from '@/lib/auth/session'
import { requireSessionUser } from '@/lib/api/guards'
import { HttpError, seeOther, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'

export const dynamic = 'force-dynamic'

const SETTINGS_PASSWORD_PATH = '/settings/password'

function parseFailureKind(error: z.ZodError): PasswordChangeFailureKind {
  for (const issue of error.issues) {
    if (issue.path[0] === 'confirmNewPassword') return 'confirmMismatch'
    if (issue.path[0] === 'newPassword') return 'passwordTooShort'
  }
  return 'malformedRequest'
}

function formFailureRedirect(error: unknown): Response {
  if (error instanceof PasswordChangeError) {
    return seeOther(`${SETTINGS_PASSWORD_PATH}?error=${error.formFlag}`)
  }
  if (error instanceof HttpError) {
    if (error.code === 'RATE_LIMITED')
      return seeOther(`${SETTINGS_PASSWORD_PATH}?error=rate_limited`)
    if (error.code === 'UNAUTHENTICATED') return seeOther('/signin')
  }
  return seeOther(`${SETTINGS_PASSWORD_PATH}?error=malformed`)
}

export async function POST(request: Request): Promise<Response> {
  const returnsJson = wantsJsonResponse(request)
  try {
    const sessionUser = await requireSessionUser()
    enforceAuthRateLimit(request, 'change-password')
    enforceChangePasswordUserRateLimit(sessionUser.id)
    const parsed = changePasswordSchema.safeParse(await readRequestBody(request))
    if (!parsed.success) {
      throw await auditPasswordChangeFailure(
        parseFailureKind(parsed.error),
        sessionUser.id,
        clientIpFromHeaders(request.headers),
      )
    }
    await changePassword({
      userId: sessionUser.id,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
      actorIp: clientIpFromHeaders(request.headers),
    })
    return seeOther(`${SETTINGS_PASSWORD_PATH}?updated=1`, {
      'set-cookie': await createSessionCookie(sessionUser.id),
    })
  } catch (error) {
    if (returnsJson) return toErrorResponse(error)
    return formFailureRedirect(error)
  }
}
