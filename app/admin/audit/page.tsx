import type { Metadata } from 'next'

import { DEFAULT_AUDIT_LIMIT } from '@/lib/admin/audit-query'
import { readAuditPage } from '@/lib/admin/audit-read'
import { listUsers } from '@/lib/admin/users'
import { AuditViewer } from './audit-viewer'
import styles from '../admin.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Audit · admin · enclave' }

export default async function AdminAuditPage() {
  const [firstPage, people] = await Promise.all([
    readAuditPage({
      action: undefined,
      actorUserId: undefined,
      artifactId: undefined,
      from: undefined,
      to: undefined,
      limit: DEFAULT_AUDIT_LIMIT,
      cursor: undefined,
    }),
    listUsers(),
  ])

  return (
    <>
      <h1 className={styles.heading}>Audit log</h1>
      <p className={styles.caption}>
        Append-only, retained for the configured window. Rows carry ids and metadata — never an
        artifact&rsquo;s title, files, or contents. An artifact id here is not a key to reading it.
      </p>

      <AuditViewer
        initialPage={firstPage}
        actors={people.map((person) => ({ id: person.id, email: person.email }))}
      />
    </>
  )
}
