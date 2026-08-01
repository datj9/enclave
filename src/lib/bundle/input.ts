import { z } from 'zod'

import { VISIBILITIES, type Visibility } from '@/db/schema/artifacts'
import type { BundleFile } from './validate'

/**
 * Decodes the `POST /api/v1/artifacts` body into the shape `validateBundle` wants, per the S2
 * contract: `{title, visibility, files:[{path, content | contentBase64}]}`. Pure — the caller
 * turns a failure into an HTTP response.
 */

const MAX_TITLE_LENGTH = 200

const fileInputSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  contentBase64: z.string().optional(),
})

export const createArtifactBodySchema = z.object({
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
  visibility: z.enum(VISIBILITIES).default('private'),
  files: z.array(fileInputSchema).min(1),
})

export interface CreateArtifactRequest {
  readonly title: string
  readonly visibility: Visibility
  readonly files: readonly BundleFile[]
}

export type CreateArtifactParse =
  | { readonly ok: true; readonly value: CreateArtifactRequest }
  | { readonly ok: false; readonly details: Record<string, unknown> }

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function decodeBase64(value: string): Buffer | undefined {
  if (value.length % 4 !== 0) return undefined
  if (!BASE64_PATTERN.test(value)) return undefined
  return Buffer.from(value, 'base64')
}

type ContentOutcome =
  | { readonly ok: true; readonly content: Buffer }
  | { readonly ok: false; readonly reason: string }

function decodeContent(file: z.infer<typeof fileInputSchema>): ContentOutcome {
  const hasPlain = file.content !== undefined
  const hasBase64 = file.contentBase64 !== undefined

  if (hasPlain && hasBase64) return { ok: false, reason: 'content_ambiguous' }
  if (file.content !== undefined) return { ok: true, content: Buffer.from(file.content, 'utf8') }
  if (file.contentBase64 === undefined) return { ok: false, reason: 'content_missing' }

  const decoded = decodeBase64(file.contentBase64)
  if (decoded === undefined) return { ok: false, reason: 'content_base64_invalid' }
  return { ok: true, content: decoded }
}

export function parseCreateArtifactBody(body: unknown): CreateArtifactParse {
  const parsed = createArtifactBodySchema.safeParse(body)
  if (!parsed.success) {
    return {
      ok: false,
      details: {
        fields: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'),
      },
    }
  }

  const files: BundleFile[] = []
  for (const file of parsed.data.files) {
    const outcome = decodeContent(file)
    if (!outcome.ok) return { ok: false, details: { path: file.path, reason: outcome.reason } }
    files.push({ path: file.path, content: outcome.content })
  }

  return {
    ok: true,
    value: { title: parsed.data.title, visibility: parsed.data.visibility, files },
  }
}
