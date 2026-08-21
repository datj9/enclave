import { z } from 'zod'

import { requireAdminUser } from '@/lib/admin/guards'
import { readJsonBody, requireJsonContentType } from '@/lib/api/guards'
import { HttpError, jsonData, toErrorResponse } from '@/lib/http'
import { getAutoCategorizeEnabled, setAutoCategorizeEnabled } from '@/lib/settings/instance-settings'

export const dynamic = 'force-dynamic'

const settingsBodySchema = z.object({ autoCategorizeEnabled: z.boolean() }).strict()

function parseSettingsBody(body: unknown): boolean {
  const parsed = settingsBodySchema.safeParse(body)
  if (!parsed.success) {
    throw new HttpError('VALIDATION_FAILED', 'The request body is not valid', {
      details: { fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)') },
    })
  }
  return parsed.data.autoCategorizeEnabled
}

export async function GET(): Promise<Response> {
  try {
    await requireAdminUser()
    return jsonData({ autoCategorizeEnabled: await getAutoCategorizeEnabled() })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const admin = await requireAdminUser()
    requireJsonContentType(request)

    const enabled = parseSettingsBody(await readJsonBody(request))
    await setAutoCategorizeEnabled(enabled, admin.id)

    return jsonData({ autoCategorizeEnabled: enabled })
  } catch (error) {
    return toErrorResponse(error)
  }
}
