import { enforceAuthRateLimit } from '@/lib/auth/rate-limit-auth'
import { createSessionCookie } from '@/lib/auth/session'
import {
  completePasswordReset,
  GENERIC_RESET_FAILURE,
  resetPasswordSchema,
} from '@/lib/auth/reset-password'
import {
  PASSWORD_RESET_TOKEN_PARAMETER,
  RESET_PASSWORD_PATH,
} from '@/lib/auth/password-reset-tokens'
import { HttpError, seeOther, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'

export const dynamic = 'force-dynamic'

function formFailureRedirect(token: string | undefined, error: 'invalid' | 'password'): Response {
  const destination = new URL(RESET_PASSWORD_PATH, 'http://placeholder.invalid')
  if (token !== undefined) destination.searchParams.set(PASSWORD_RESET_TOKEN_PARAMETER, token)
  destination.searchParams.set('error', error)
  return seeOther(`${destination.pathname}${destination.search}`)
}

export async function POST(request: Request): Promise<Response> {
  const returnsJson = wantsJsonResponse(request)
  let submittedToken: string | undefined

  try {
    enforceAuthRateLimit(request, 'reset-password')

    const body = await readRequestBody(request)
    const parsed = resetPasswordSchema.safeParse(body)
    if (!parsed.success) {
      const passwordFailed = parsed.error.issues.some((issue) => issue.path[0] === 'password')
      throw new HttpError(
        'VALIDATION_FAILED',
        passwordFailed ? 'Enter a password of at least 12 characters' : GENERIC_RESET_FAILURE,
      )
    }

    submittedToken = parsed.data.token
    const completed = await completePasswordReset({
      token: parsed.data.token,
      password: parsed.data.password,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return seeOther('/dashboard', {
      'set-cookie': await createSessionCookie(completed.userId),
    })
  } catch (error) {
    if (returnsJson) return toErrorResponse(error)
    const passwordError =
      error instanceof HttpError && error.message === 'Enter a password of at least 12 characters'
    return formFailureRedirect(submittedToken, passwordError ? 'password' : 'invalid')
  }
}
