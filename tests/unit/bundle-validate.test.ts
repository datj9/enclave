import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_TYPE_BY_EXTENSION,
  ENTRY_PATH,
  bundleLimitsFromEnv,
  validateBundle,
  type BundleFile,
  type BundleLimits,
  type BundleValidation,
} from '@/lib/bundle/validate'

/**
 * Every acceptance criterion in S2's US-6 list is a case here, plus every remaining branch —
 * the validator is the one module the ticket holds to 100% branch coverage.
 */

const LIMITS: BundleLimits = {
  maxFiles: 50,
  maxFileBytes: 2_097_152,
  maxTotalBytes: 10_485_760,
}

function file(path: string, content = 'x'): BundleFile {
  return { path, content: Buffer.from(content, 'utf8') }
}

function fileOfBytes(path: string, bytes: number): BundleFile {
  return { path, content: Buffer.alloc(bytes, 0x61) }
}

const entry = () => file(ENTRY_PATH, '<!doctype html>')

function expectFailure(result: BundleValidation, code: string): Record<string, unknown> {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected a failure')
  expect(result.code).toBe(code)
  return result.details
}

describe('validateBundle · happy path', () => {
  it('returns a manifest matching the S2 worked example shape', () => {
    const indexHtml = '<!doctype html><script src=./app.js></script>'
    const appJs = 'console.log(1)'

    const result = validateBundle([file(ENTRY_PATH, indexHtml), file('app.js', appJs)], LIMITS)

    // The ticket's worked example prints 44/58 for these strings; the entry document is actually
    // 45 bytes, so the byte counts come from the input rather than from the transcribed numbers.
    expect(result).toEqual({
      ok: true,
      manifest: [
        {
          path: 'index.html',
          bytes: 45,
          content_type: 'text/html',
          sha256: createHash('sha256').update(indexHtml).digest('hex'),
        },
        {
          path: 'app.js',
          bytes: 14,
          content_type: 'text/javascript',
          sha256: createHash('sha256').update(appJs).digest('hex'),
        },
      ],
    })
    expect(Buffer.byteLength(indexHtml, 'utf8')).toBe(45)
  })

  it('accepts nested paths, dots and hyphens', () => {
    const result = validateBundle(
      [entry(), file('assets/sub-dir/my.file.name.css', 'a{}')],
      LIMITS,
    )

    expect(result.ok).toBe(true)
  })

  it('maps every allowlisted extension to its declared content type, never sniffing', () => {
    const files = Object.keys(CONTENT_TYPE_BY_EXTENSION).map((extension) =>
      // Deliberately HTML bytes under every extension: the type comes from the name (§4.4).
      file(`asset.${extension}`, '<!doctype html>'),
    )

    const result = validateBundle([entry(), ...files], LIMITS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const manifestEntry of result.manifest.slice(1)) {
      const extension = manifestEntry.path.split('.').at(-1) ?? ''
      expect(manifestEntry.content_type).toBe(CONTENT_TYPE_BY_EXTENSION[extension])
    }
  })

  it('uppercases in an extension still resolve', () => {
    const result = validateBundle([entry(), file('READY.MD', '# hi')], LIMITS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest[1]?.content_type).toBe('text/markdown')
  })

  it('accepts a zero-byte file', () => {
    const result = validateBundle([entry(), fileOfBytes('empty.txt', 0)], LIMITS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest[1]?.bytes).toBe(0)
  })

  it('falls back to the environment limits when none are passed', () => {
    expect(validateBundle([entry()]).ok).toBe(true)
  })
})

describe('validateBundle · path rules (§5.5)', () => {
  it('rejects a traversal path with PATH_INVALID', () => {
    // US-6 AC1 — the headline security case.
    const details = expectFailure(
      validateBundle([entry(), file('../../etc/passwd')], LIMITS),
      'PATH_INVALID',
    )

    expect(details).toEqual({ path: '../../etc/passwd' })
  })

  it.each([
    ['a leading slash', '/index.css'],
    ['a bare parent segment', 'a/../b.css'],
    ['a doubled slash', 'a//b.css'],
    ['a backslash', 'a\\b.css'],
    ['a null byte', 'a\u0000b.css'],
    ['a space', 'my file.css'],
    ['a colon', 'c:file.css'],
    ['a query string', 'app.js?v=1'],
    ['a percent escape', '%2e%2e/app.js'],
    ['an empty path', ''],
  ])('rejects %s', (_label, path) => {
    expectFailure(validateBundle([entry(), file(path)], LIMITS), 'PATH_INVALID')
  })

  it('rejects a path longer than 200 characters', () => {
    const longPath = `${'a'.repeat(198)}.js`

    expect(validateBundle([entry(), file(`${'a'.repeat(197)}.js`)], LIMITS).ok).toBe(true)
    expect(longPath.length).toBe(201)
    expectFailure(validateBundle([entry(), file(longPath)], LIMITS), 'PATH_INVALID')
  })
})

describe('validateBundle · extension allowlist (§5.5)', () => {
  it('rejects a .php file', () => {
    // US-6 AC3.
    const details = expectFailure(
      validateBundle([entry(), file('shell.php', '<?php ?>')], LIMITS),
      'FILE_TYPE_NOT_ALLOWED',
    )

    expect(details).toEqual({ path: 'shell.php' })
  })

  it.each([
    ['no extension at all', 'README'],
    ['a dotfile', '.gitignore'],
    ['a trailing dot', 'index.'],
    ['a dotfile in a subdirectory', 'assets/.env'],
    ['a double extension ending outside the allowlist', 'index.html.php'],
  ])('rejects %s', (_label, path) => {
    expectFailure(validateBundle([entry(), file(path)], LIMITS), 'FILE_TYPE_NOT_ALLOWED')
  })
})

describe('validateBundle · limits (decision #15)', () => {
  it('rejects 51 files with BUNDLE_TOO_LARGE and accepts 50', () => {
    // US-6 AC2.
    const bundleOf = (count: number) => [
      entry(),
      ...Array.from({ length: count - 1 }, (_unused, index) => file(`file-${index}.js`)),
    ]

    expect(validateBundle(bundleOf(50), LIMITS).ok).toBe(true)
    const details = expectFailure(validateBundle(bundleOf(51), LIMITS), 'BUNDLE_TOO_LARGE')
    expect(details).toEqual({ fileCount: 51, maxFiles: 50 })
  })

  it('rejects a single file over 2 MB and accepts one exactly at the limit', () => {
    expect(validateBundle([entry(), fileOfBytes('big.js', 2_097_152)], LIMITS).ok).toBe(true)

    const details = expectFailure(
      validateBundle([entry(), fileOfBytes('big.js', 2_097_153)], LIMITS),
      'BUNDLE_TOO_LARGE',
    )
    expect(details).toEqual({ path: 'big.js', bytes: 2_097_153, maxFileBytes: 2_097_152 })
  })

  it('rejects a total over 10 MB even when every file is within the per-file limit', () => {
    const files = [
      entry(),
      ...Array.from({ length: 6 }, (_unused, index) =>
        fileOfBytes(`chunk-${index}.js`, 2_000_000),
      ),
    ]

    const details = expectFailure(validateBundle(files, LIMITS), 'BUNDLE_TOO_LARGE')
    expect(details).toEqual({ totalBytes: 12_000_015, maxTotalBytes: 10_485_760 })
  })

  it('accepts a total exactly at the limit', () => {
    const files = [
      fileOfBytes(ENTRY_PATH, 485_760),
      ...Array.from({ length: 5 }, (_unused, index) =>
        fileOfBytes(`chunk-${index}.js`, 2_000_000),
      ),
    ]

    expect(validateBundle(files, LIMITS).ok).toBe(true)
  })
})

describe('validateBundle · structural rules', () => {
  it('rejects duplicate paths rather than letting the last write win', () => {
    // US-6 AC5.
    const details = expectFailure(
      validateBundle([entry(), file('app.js', 'first'), file('app.js', 'second')], LIMITS),
      'VALIDATION_FAILED',
    )

    expect(details).toEqual({ reason: 'duplicate_path', path: 'app.js' })
  })

  it('rejects a bundle without index.html', () => {
    // US-6 AC4.
    const details = expectFailure(
      validateBundle([file('app.js'), file('style.css', 'a{}')], LIMITS),
      'ENTRY_MISSING',
    )

    expect(details).toEqual({ expected: ENTRY_PATH })
  })

  it('does not accept index.html nested in a subdirectory as the entry', () => {
    expectFailure(validateBundle([file('nested/index.html')], LIMITS), 'ENTRY_MISSING')
  })

  it('rejects an empty bundle', () => {
    const details = expectFailure(validateBundle([], LIMITS), 'VALIDATION_FAILED')

    expect(details).toEqual({ reason: 'bundle_empty' })
  })
})

describe('bundleLimitsFromEnv', () => {
  it('reads the three §5.7 bundle variables', () => {
    expect(bundleLimitsFromEnv()).toEqual(LIMITS)
  })
})
