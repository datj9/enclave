import { pingDatabase } from '@/db'
import { jsonData, jsonError } from '@/lib/http'

export const dynamic = 'force-dynamic'

/**
 * Readiness, not liveness: a 200 means this process can serve requests, which requires
 * Postgres. Object storage is deliberately not probed — an unreachable bucket degrades
 * artifact serving but must not take the whole instance out of a load balancer.
 */
export async function GET(): Promise<Response> {
  try {
    await pingDatabase()
    return jsonData({ status: 'ok', database: 'ok' }, 200, { 'cache-control': 'no-store' })
  } catch {
    return jsonError('INTERNAL_ERROR', 'Database is unreachable', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    })
  }
}
