import type { Metadata } from 'next'

import { listUsers } from '@/lib/admin/users'
import { getSessionUser } from '@/lib/auth/session'
import { UserTable } from './user-table'
import styles from '../admin.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Users · admin · enclave' }

export default async function AdminUsersPage() {
  // The layout already refused everyone else; this is only to mark the admin's own row.
  const sessionUser = await getSessionUser()

  return (
    <>
      <h1 className={styles.heading}>Users</h1>
      <p className={styles.caption}>
        Deactivating an account ends its sessions immediately and removes its write access. The
        artifacts it shared — Organization or Public — stay readable, which is what the Shared count
        is for: deactivation is about the person, not their work. Deleting is refused while the
        account still owns artifacts.
      </p>

      <UserTable initialUsers={await listUsers()} currentUserId={sessionUser?.id ?? ''} />
    </>
  )
}
