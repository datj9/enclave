import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '@/env'
import * as schema from './schema'

export type Database = PostgresJsDatabase<typeof schema>

/**
 * One pooled client per process. Next.js dev reloads re-evaluate this module, so the client is
 * stashed on globalThis to stop connections accumulating until Postgres refuses new ones.
 */
const globalForDb = globalThis as unknown as {
  enclaveSql?: postgres.Sql
  enclaveDb?: Database
}

/**
 * Both exports below are lazy on purpose. `next build` evaluates every route module to collect
 * page data, and it does that without an environment — connecting at module scope would fail
 * the Docker build. Nothing touches Postgres until a request actually asks for it.
 */
function getSql(): postgres.Sql {
  return (globalForDb.enclaveSql ??= postgres(env.DATABASE_URL, { max: 10, prepare: false }))
}

function getDb(): Database {
  return (globalForDb.enclaveDb ??= drizzle(getSql(), { schema }))
}

function lazyProxy<TTarget extends object>(resolve: () => TTarget): TTarget {
  return new Proxy({} as TTarget, {
    get: (_target, property) => {
      const resolved = resolve()
      const value = Reflect.get(resolved, property, resolved) as unknown
      return typeof value === 'function' ? value.bind(resolved) : value
    },
    has: (_target, property) => property in resolve(),
  })
}

/**
 * The handle every slice imports. For raw SQL use drizzle's own template:
 * `db.execute(sql\`select now()\`)` — there is deliberately no exported driver instance.
 */
export const db: Database = lazyProxy(getDb)

/** Cheapest possible round-trip; `/healthz` uses it to prove connectivity, not liveness. */
export async function pingDatabase(): Promise<void> {
  await getSql()`select 1`
}
