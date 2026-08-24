import { describe, expect, it } from 'vitest'
import {
  GENERIC_FORGOT_PASSWORD_SUCCESS,
  PASSWORD_RESET_EMAIL_SUBJECT,
  forgotPasswordSchema,
  passwordResetEmailText,
} from '@/lib/auth/forgot-password'

const RESET_URL = 'http://localhost:3000/reset-password?t=pwr_testtoken_0123456789abcdefgh'

describe('forgotPasswordSchema', () => {
  it('normalises email like credentialsSchema', () => {
    const parsed = forgotPasswordSchema.parse({ email: '  OPS@Example.COM  ' })

    expect(parsed.email).toBe('ops@example.com')
  })

  it('rejects a malformed email', () => {
    expect(forgotPasswordSchema.safeParse({ email: 'not-an-email' }).success).toBe(false)
  })
})

describe('forgot-password copy', () => {
  it('exports the locked success copy', () => {
    expect(GENERIC_FORGOT_PASSWORD_SUCCESS).toBe(
      'If that email is on this instance, we sent a reset link.',
    )
  })

  it('builds a plaintext body that contains the url and the expiry sentence and no html tags', () => {
    const body = passwordResetEmailText(RESET_URL)

    expect(body).toContain(RESET_URL)
    expect(body).toContain('This link expires in 1 hour.')
    expect(body).toContain(
      'Requesting another reset link replaces this one, so only the newest link still works.',
    )
    expect(body).not.toMatch(/<[^>]+>|&[a-z]+;/i)
    expect(PASSWORD_RESET_EMAIL_SUBJECT).toBe('Reset your enclave password')
  })
})
