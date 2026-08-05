import type { Metadata } from 'next'

import { env } from '@/env'
import { INVITE_ONLY_NOTICE, registrationModeLabel } from '@/lib/admin/registration-notice'
import styles from '../admin.module.css'

/**
 * Instance configuration, read-only. Every value below comes from the validated environment
 * (`src/env.ts`), which is the single source of truth a restart re-reads — so the console reports
 * them rather than offering an override that would silently disagree with the deployment's own
 * `.env`. Changing one means changing the environment and restarting.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings · admin · enclave' }

interface Setting {
  readonly name: string
  readonly value: string
  readonly note: string
}

function quotaSettings(): readonly Setting[] {
  return [
    {
      name: 'QUOTA_GENERATIONS_PER_DAY',
      value: String(env.QUOTA_GENERATIONS_PER_DAY),
      note: "Daily generations per user on the instance's own provider key.",
    },
    {
      name: 'QUOTA_GENERATIONS_PER_DAY_OWN_KEY',
      value: String(env.QUOTA_GENERATIONS_PER_DAY_OWN_KEY),
      note: 'Daily generations per user when they supply their own provider key.',
    },
    {
      name: 'RATE_LIMIT_GENERATIONS_PER_HOUR',
      value: String(env.RATE_LIMIT_GENERATIONS_PER_HOUR),
      note: 'Rolling hourly cap per user, so one account cannot drain the key in a burst.',
    },
    {
      name: 'RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY',
      value: String(env.RATE_LIMIT_GENERATIONS_PER_HOUR_OWN_KEY),
      note: 'Rolling hourly cap per user when they supply their own provider key.',
    },
    {
      name: 'RATE_LIMIT_AUTH_PER_IP_PER_HOUR',
      value: String(env.RATE_LIMIT_AUTH_PER_IP_PER_HOUR),
      note: 'Failed sign-in, setup, and signup attempts allowed per IP per hour.',
    },
    {
      name: 'AUDIT_RETENTION_DAYS',
      value: String(env.AUDIT_RETENTION_DAYS),
      note: 'How long audit rows are kept before the retention job prunes them.',
    },
    {
      name: 'TRASH_RETENTION_DAYS',
      value: String(env.TRASH_RETENTION_DAYS),
      note: 'How long a deleted artifact stays restorable.',
    },
  ]
}

export default function AdminSettingsPage() {
  const isOpenRegistration = env.ALLOW_OPEN_REGISTRATION

  return (
    <>
      <h1 className={styles.heading}>Settings</h1>
      <p className={styles.caption}>
        These come from this deployment&rsquo;s environment and are validated at startup. Edit the
        environment and restart to change one — the console reports them so the values you see are
        always the values in force.
      </p>

      <ul className={styles.settingList}>
        <li className={styles.settingRow}>
          <span className={styles.settingName}>ALLOW_OPEN_REGISTRATION</span>
          <span>
            Registration is <strong>{registrationModeLabel(isOpenRegistration)}</strong>.{' '}
            {isOpenRegistration ? '' : INVITE_ONLY_NOTICE}
          </span>
        </li>

        {quotaSettings().map((setting) => (
          <li className={styles.settingRow} key={setting.name}>
            <span className={styles.settingName}>{setting.name}</span>
            <span>
              <strong>{setting.value}</strong> — {setting.note}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}
