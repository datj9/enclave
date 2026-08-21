import type { Metadata } from 'next'

import { listCategories } from '@/lib/categories/manage'
import { CategoryManager } from './category-manager'
import styles from '../admin.module.css'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Categories · admin · enclave' }

export default async function AdminCategoriesPage() {
  return (
    <>
      <h1 className={styles.heading}>Categories</h1>
      <p className={styles.caption}>
        Categories are the tag taxonomy for artifacts. Create one, then owners can tag their
        artifacts with it. Deactivating a category hides it from new tags and from public pages.
      </p>

      <CategoryManager initialCategories={await listCategories({ includeInactive: true })} />
    </>
  )
}
