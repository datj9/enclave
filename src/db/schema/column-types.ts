import { customType } from 'drizzle-orm/pg-core'

/** Postgres `citext`, so email uniqueness is case-insensitive without a functional index. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
})
