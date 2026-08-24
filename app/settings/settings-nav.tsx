'use client'

import { usePathname } from 'next/navigation'
import styles from './settings.module.css'

/**
 * Client-side only for `usePathname`, so the current section is marked with `aria-current` — the
 * same shape as `app/admin/admin-nav.tsx`.
 */

const SECTIONS: ReadonlyArray<{ readonly href: string; readonly label: string }> = [
  { href: '/settings/password', label: 'Password' },
  { href: '/settings/keys', label: 'Provider key' },
  { href: '/settings/tokens', label: 'API tokens' },
]

export function SettingsNav() {
  const pathname = usePathname()

  return (
    <nav className={styles.nav} aria-label="Settings sections">
      {SECTIONS.map((section) => (
        <a
          className={styles.navLink}
          key={section.href}
          href={section.href}
          {...(pathname === section.href ? { 'aria-current': 'page' as const } : {})}
        >
          {section.label}
        </a>
      ))}
    </nav>
  )
}
