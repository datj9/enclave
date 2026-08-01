import postgres from 'postgres'

/**
 * `/setup` is single-use per database, so the suite starts from an empty `users` table.
 * DATABASE_URL here is the host-side URL from .env (Postgres published on 5434), not the
 * compose-internal one the app container uses.
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not set — copy .env.example to .env before running e2e tests')
  }

  const sql = postgres(databaseUrl, { max: 1 })
  try {
    await sql`truncate table users cascade`
  } finally {
    await sql.end()
  }
}
