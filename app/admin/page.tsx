import { redirect } from 'next/navigation'

/** The console has no dashboard of its own; users is the section an operator wants first. */
export default function AdminIndexPage() {
  redirect('/admin/users')
}
