import type { z } from 'zod'

import { recordAuditEvent } from '@/lib/audit'
import {
  changePassword,
  changePasswordSchema,
  CURRENT_PASSWORD_INCORRECT,
  NO_PASSWORD_ACCOUNT,
  CHOOSE_DIFFERENT_PASSWORD,
  PASSWORD_CONFIRM_MISMATCH,
  PASSWORD_TOO_SHORT,
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

type FormErrorFlag =
  'wrong_current' | 'mismatch' | 'password' | 'same' | 'no_password' | 'malformed' | 'rate_limited'

function messageForParseFailure(error: z.ZodError): {
  readonly message: string
  readonly flag: FormErrorFlag
} {
  for (const issue of error.issues) {
    if (issue.path[0] === 'confirmNewPassword') {
      return { message: PASSWORD_CONFIRM_MISMATCH, flag: 'mismatch' }
    }
    if (issue.path[0] === 'newPassword') {
      return { message: PASSWORD_TOO_SHORT, flag: 'password' }
    }
  }
  return {
    message: 'Enter your current password and a new password of at least 12 characters',
    flag: 'malformed',
  }
}

function formErrorFlag(error: unknown): FormErrorFlag {
  if (error instanceof HttpError) {
    if (error.code === 'RATE_LIMITED') return 'rate_limited'
    if (error.message === CURRENT_PASSWORD_INCORRECT) return 'wrong_current'
    if (error.message === NO_PASSWORD_ACCOUNT) return 'no_password'
    if (error.message === CHOOSE_DIFFERENT_PASSWORD) return 'same'
    if (error.message === PASSWORD_CONFIRM_MISMATCH) return 'mismatch'
    if (error.message === PASSWORD_TOO_SHORT) return 'password'
  }
  return 'malformed'
}

function formFailureRedirect(error: unknown): Response {
  if (
    error instanceof HttpError &&
    error.code === 'UNAUTHENTICATED' &&
    error.message === 'Sign in to continue'
  ) {
    return seeOther('/signin')
  }
  return seeOther(`${SETTINGS_PASSWORD_PATH}?error=${formErrorFlag(error)}`)
}

export async function POST(request: Request): Promise<Response> {
  const returnsJson = wantsJsonResponse(request)
  try {
    const sessionUser = await requireSessionUser()
    enforceAuthRateLimit(request, 'change-password')
    enforceChangePasswordUserRateLimit(sessionUser.id)
    const parsed = changePasswordSchema.safeParse(await readRequestBody(request))
    if (!parsed.success) {
      const { message } = messageForParseFailure(parsed.error)
      await recordAuditEvent({
        action: 'auth.password_change_failed',
        actorUserId: sessionUser.id,
        actorIp: clientIpFromHeaders(request.headers),
        metadata: { reason: 'malformed' },
      })
      throw new HttpError('VALIDATION_FAILED', message)
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
