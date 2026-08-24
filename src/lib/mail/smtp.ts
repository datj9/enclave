import nodemailer from 'nodemailer'

import { env } from '@/env'

/**
 * Optional SMTP transport for password reset mail. `isMailConfigured()` is `SMTP_HOST` being set;
 * with no host the instance boots and forgot-password still returns the generic success page.
 *
 * `sendMail` is lazy: no transporter is constructed at module load, and every call builds one
 * (or uses the test override), so nothing network-shaped happens on import.
 */

export class MailNotConfiguredError extends Error {
  constructor() {
    super('SMTP is not configured')
    this.name = 'MailNotConfiguredError'
  }
}

export interface SendMailInput {
  readonly to: string
  readonly subject: string
  readonly text: string
}

export interface MailTransporter {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>
}

export function isMailConfigured(): boolean {
  return env.SMTP_HOST !== undefined
}

export function mailFromAddress(): string {
  return env.SMTP_FROM ?? `enclave@${new URL(env.APP_URL).hostname}`
}

// Test seam, same idea as resetRateLimits in src/lib/rate-limit.ts.
let testTransporter: MailTransporter | undefined

export function setMailTransporterForTests(transporter: MailTransporter | undefined): void {
  testTransporter = transporter
}

function resolveTransporter(): MailTransporter {
  if (testTransporter !== undefined) return testTransporter
  if (!isMailConfigured()) throw new MailNotConfiguredError()
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USER === undefined
        ? undefined
        : { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' },
  })
}

/** Mail is plaintext only: no HTML part, so a leaked mail client can never execute markup. */
export async function sendMail(input: SendMailInput): Promise<void> {
  const transporter = resolveTransporter()
  await transporter.sendMail({
    from: mailFromAddress(),
    to: input.to,
    subject: input.subject,
    text: input.text,
  })
}
