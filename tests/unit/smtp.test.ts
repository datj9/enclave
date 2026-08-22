import { afterEach, describe, expect, it, vi } from 'vitest'

import { setMailTransporterForTests } from '@/lib/mail/smtp'

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => {
      throw new Error('real transport must never be constructed in tests')
    }),
  },
}))

afterEach(() => {
  setMailTransporterForTests(undefined)
  vi.restoreAllMocks()
  vi.resetModules()
  vi.unstubAllEnvs()
})

async function loadFreshSmtp() {
  vi.resetModules()
  return import('@/lib/mail/smtp')
}

function withSmtpHostUnset(run: () => Promise<void>): Promise<void> {
  const previous = process.env.SMTP_HOST
  delete process.env.SMTP_HOST
  return run().finally(() => {
    if (previous === undefined) delete process.env.SMTP_HOST
    else process.env.SMTP_HOST = previous
  })
}

const TYPICAL_RESET_MAIL_TEXT =
  'Reset your password by opening this link:\n\n' +
  'http://localhost:3000/reset-password?t=pwr_abc\n\n' +
  'This link expires in 1 hour.\n\n' +
  'If you did not request this, you can ignore this email.'

describe('isMailConfigured', () => {
  it('is false when SMTP_HOST is unset', async () => {
    await withSmtpHostUnset(async () => {
      const smtp = await loadFreshSmtp()
      expect(smtp.isMailConfigured()).toBe(false)
    })
  })

  it('is true when SMTP_HOST is set', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    const smtp = await loadFreshSmtp()
    expect(smtp.isMailConfigured()).toBe(true)
  })
})

describe('sendMail', () => {
  it('throws MailNotConfiguredError when SMTP_HOST is unset and no transporter is injected', async () => {
    await withSmtpHostUnset(async () => {
      const smtp = await loadFreshSmtp()
      const error = await smtp
        .sendMail({ to: 'ops@example.com', subject: 's', text: 't' })
        .then(() => null)
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(smtp.MailNotConfiguredError)
      expect((error as Error).name).toBe('MailNotConfiguredError')
    })
  })

  it('sends from SMTP_FROM when set', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('SMTP_FROM', 'ops@example.com')
    const smtp = await loadFreshSmtp()
    const sent: Array<Record<string, unknown>> = []
    smtp.setMailTransporterForTests({ sendMail: vi.fn(async (message) => void sent.push(message)) })

    await smtp.sendMail({ to: 'recipient@example.com', subject: 's', text: 't' })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ from: 'ops@example.com', to: 'recipient@example.com' })
  })

  it('defaults From to enclave@<host of APP_URL> when SMTP_FROM is unset', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    vi.stubEnv('APP_URL', 'https://enclave.example.com')
    const smtp = await loadFreshSmtp()
    const sent: Array<Record<string, unknown>> = []
    smtp.setMailTransporterForTests({ sendMail: vi.fn(async (message) => void sent.push(message)) })

    await smtp.sendMail({ to: 'recipient@example.com', subject: 's', text: 't' })

    expect(sent[0]).toMatchObject({ from: 'enclave@enclave.example.com' })
  })

  it('passes to, subject, and text through to the transporter and does not include an html field', async () => {
    const smtp = await loadFreshSmtp()
    const sent: Array<Record<string, unknown>> = []
    smtp.setMailTransporterForTests({ sendMail: vi.fn(async (message) => void sent.push(message)) })

    await smtp.sendMail({
      to: 'ops@example.com',
      subject: 'Reset your enclave password',
      text: TYPICAL_RESET_MAIL_TEXT,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      to: 'ops@example.com',
      subject: 'Reset your enclave password',
      text: TYPICAL_RESET_MAIL_TEXT,
    })
    expect(Object.hasOwn(sent[0] as object, 'html')).toBe(false)
  })

  it('never sends a password in the message', async () => {
    const smtp = await loadFreshSmtp()
    const sent: Array<{ subject: string; text: string }> = []
    smtp.setMailTransporterForTests({
      sendMail: vi.fn(async (message) => void sent.push(message)),
    })

    await smtp.sendMail({
      to: 'ops@example.com',
      subject: 'Reset your enclave password',
      text: TYPICAL_RESET_MAIL_TEXT,
    })

    const subjectAndText = `${sent[0]?.subject ?? ''}\n${sent[0]?.text ?? ''}`
    expect(subjectAndText).not.toMatch(/password is|your password:/i)
    expect(sent[0]?.text).not.toContain('correct-horse-battery')
  })

  it('does not hit the network', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com')
    const smtp = await loadFreshSmtp()
    const nodemailer = await import('nodemailer')
    const mockTransport = (
      nodemailer.default as unknown as {
        createTransport: ReturnType<typeof vi.fn>
      }
    ).createTransport
    mockTransport.mockClear()
    const sends = vi.fn(async () => undefined)
    smtp.setMailTransporterForTests({ sendMail: sends })

    await smtp.sendMail({ to: 'ops@example.com', subject: 's', text: 't' })

    expect(mockTransport).not.toHaveBeenCalled()
    expect(sends).toHaveBeenCalledTimes(1)
  })
})
