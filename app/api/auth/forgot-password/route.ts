import { forgotPasswordSchema, requestPasswordReset } from '@/lib/auth/forgot-password'
import {
  enforceAuthRateLimit,
  enforceForgotPasswordEmailRateLimit,
} from '@/lib/auth/rate-limit-auth'
import { HttpError, seeOther, toErrorResponse } from '@/lib/http'
import { clientIpFromHeaders } from '@/lib/rate-limit'
import { readRequestBody, wantsJsonResponse } from '@/lib/request'

export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const returnsJson = wantsJsonResponse(request)

  try {
    enforceAuthRateLimit(request, 'forgot-password')

    const parsed = forgotPasswordSchema.safeParse(await readRequestBody(request))
    if (!parsed.success) {
      throw new HttpError('VALIDATION_FAILED', 'Enter a valid email address')
    }

    enforceForgotPasswordEmailRateLimit(parsed.data.email)

    await requestPasswordReset({
      email: parsed.data.email,
      actorIp: clientIpFromHeaders(request.headers),
    })

    return seeOther('/forgot-password?sent=1')
  } catch (error) {
    if (returnsJson) return toErrorResponse(error)
    return seeOther('/forgot-password?error=invalid')
  }
}
