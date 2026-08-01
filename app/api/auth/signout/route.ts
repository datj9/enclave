import { clearSessionCookie } from '@/lib/auth/session'
import { seeOther } from '@/lib/http'

export const dynamic = 'force-dynamic'

export async function POST(): Promise<Response> {
  return seeOther('/signin', { 'set-cookie': clearSessionCookie() })
}
