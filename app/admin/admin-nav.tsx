'use client'

import { usePathname } from 'next/navigation'
import styles from './admin.module.css'

/**
 * Client-side only for `usePathname`, so the current section is marked with `aria-current`. No
 * transition on the marker: navigation happens tens of times a session (docs/motion.md).
 */

const SECTIONS: ReadonlyArray<{ readonly href: string; readonly label: string }> = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/invites', label: 'Invites' },
  { href: '/admin/audit', label: 'Audit' },
  { href: '/admin/settings', label: 'Settings' },
]

export function AdminNav() {
  const pathname = usePathname()

  return (
    <nav className={styles.nav} aria-label="Admin sections">
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
