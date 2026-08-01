import type { Metadata } from 'next'

import { listInvites } from '@/lib/invites/manage'
import { InviteManager } from './invite-manager'
import styles from '../admin.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Invites · admin · enclave' }

export default async function AdminInvitesPage() {
  return (
    <>
      <h1 className={styles.heading}>Invites</h1>
      <p className={styles.caption}>
        An invite is single-use and expires. Copy the link when you create it — nothing can show it
        again. There is no email delivery on this instance; send the link however you already talk to
        the person.
      </p>

      <InviteManager initialInvites={await listInvites()} />
    </>
  )
}
