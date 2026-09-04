import { describe, expect, it, vi } from 'vitest'

import { env } from '@/env'
import type { AuthorizedVersion } from '@/lib/artifacts/authorize'
import { buildDownload } from '@/lib/artifacts/export/build-download'
import { htmlToMarkdown } from '@/lib/artifacts/export/html-to-markdown'
import { inlineBundle } from '@/lib/artifacts/export/inline-html'
import { ENTRY_PATH, type ManifestEntry } from '@/lib/bundle/validate'
import { storageKey, type ObjectStore } from '@/lib/storage/object-store'

/**
 * The download export utilities, against a fake in-memory ObjectStore — no DB, no S3. US2 lives
 * here (a downloaded `.html` is self-contained), plus the ref-resolution edge cases the inliner
 * is the only place that can exercise.
 */

interface StoredObject {
  readonly body: Buffer
  readonly contentType: string
}

const ARTIFACT_ID = 'artifact-1'
const VERSION_ID = 'version-1'

/** The minimal ObjectStore the export utilities read through, keyed by storageKey. */
function fakeStore(entries: Readonly<Record<string, StoredObject>>): ObjectStore {
  return {
    ensureBucket: async () => {},
    putObject: async () => {},
    getObject: async (key: string) => entries[key],
    getObjectStream: async () => undefined,
    presignGetUrl: async () => '',
    listKeys: async () => [],
    deletePrefix: async () => {},
  }
}

function manifestEntry(path: string, contentType: string, content: string): ManifestEntry {
  return {
    path,
    bytes: Buffer.byteLength(content, 'utf8'),
    content_type: contentType,
    sha256: 'fake',
  }
}

/**
 * A store holding `files` under the real `storageKey` prefix, plus the manifest those files
 * produce — the same two views the object store and the DB have of one bundle.
 */
function storeWith(files: Readonly<Record<string, StoredObject>>): {
  readonly store: ObjectStore
  readonly manifest: readonly ManifestEntry[]
} {
  const entries: Record<string, StoredObject> = {}
  for (const [path, object] of Object.entries(files)) {
    entries[storageKey(ARTIFACT_ID, VERSION_ID, path)] = object
  }
  const manifest = Object.entries(files).map(([path, object]) =>
    manifestEntry(path, object.contentType, object.body.toString('utf8')),
  )
  return { store: fakeStore(entries), manifest }
}

const HTML_OBJECT = (body: string): StoredObject => ({ body: Buffer.from(body, 'utf8'), contentType: 'text/html' })
const CSS_OBJECT = (body: string): StoredObject => ({ body: Buffer.from(body, 'utf8'), contentType: 'text/css' })
const JS_OBJECT = (body: string): StoredObject => ({ body: Buffer.from(body, 'utf8'), contentType: 'text/javascript' })
const PNG_OBJECT = (bytes: number[]): StoredObject => ({ body: Buffer.from(bytes), contentType: 'image/png' })

describe('htmlToMarkdown', () => {
  it('converts the entry HTML to markdown, keeping headings and links', () => {
    const markdown = htmlToMarkdown(
      '<h1>Sales dash</h1><p>See <a href="https://example.com/report">the report</a>.</p>',
    )
    expect(markdown).toContain('Sales dash')
    expect(markdown).toContain('[the report](https://example.com/report)')
  })
})

describe('inlineBundle · self-contained HTML (US2)', () => {
  it('inlines stylesheet <link> and a manifest-listed relative <img> as a data URI', async () => {
    const css = 'body { color: #333; }'
    const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT(
        '<!doctype html><link rel="stylesheet" href="./assets/style.css"><img src="img/logo.png">',
      ),
      'assets/style.css': CSS_OBJECT(css),
      'img/logo.png': PNG_OBJECT(pngBytes),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('<style>')
    expect(html).toContain('body { color: #333; }')
    expect(html).not.toContain('assets/style.css')
    // The relative <img src> is gone; a data: URI with the manifest's content type took its place.
    expect(html).not.toContain('src="img/logo.png"')
    expect(html).toMatch(/src="data:image\/png;base64,[A-Za-z0-9+/=]+"/)
  })

  it('resolves refs against the entry directory, normalising ./ and ../', async () => {
    const { store, manifest } = storeWith({
      'docs/guide.html': HTML_OBJECT(
        '<!doctype html><link rel="stylesheet" href="../assets/style.css"><img src="../img/logo.png">',
      ),
      'assets/style.css': CSS_OBJECT('p { margin: 0 }'),
      'img/logo.png': PNG_OBJECT([0x89, 0x50]),
    })

    const html = await inlineBundle(
      { artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: 'docs/guide.html', manifest },
      store,
    )

    expect(html).toContain('<style>p { margin: 0 }</style>')
    expect(html).toContain('src="data:image/png;base64,')
  })

  it('strips a leading / from a root-relative reference', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html><script src="/app.js"></script>'),
      'app.js': JS_OBJECT('console.log(1)'),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('<script>console.log(1)</script>')
  })

  it('drops ?query and #hash before resolving', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html><img src="img/logo.png?v=2#head">'),
      'img/logo.png': PNG_OBJECT([0x89, 0x50]),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('src="data:image/png;base64,')
  })

  it('leaves absolute and scheme-ful refs untouched — including data: and //', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT(
        '<!doctype html><link rel="stylesheet" href="https://cdn.example.com/site.css">' +
          '<script src="//cdn.example.com/app.js"></script>' +
          '<img src="data:image/png;base64,AAAA">' +
          '<img src="http://example.com/logo.png">',
      ),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('href="https://cdn.example.com/site.css"')
    expect(html).toContain('src="//cdn.example.com/app.js"')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain('src="http://example.com/logo.png"')
  })

  it('leaves a ref that is not in the manifest untouched', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html><img src="img/missing.png">'),
      // img/logo.png exists; img/missing.png does not.
      'img/logo.png': PNG_OBJECT([0x89, 0x50]),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('src="img/missing.png"')
  })

  it('leaves <a href>, <iframe>, <video>/<source> and <use href> untouched', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT(
        '<!doctype html><a href="next.html">next</a>' +
          '<iframe src="frame.html"></iframe>' +
          '<video src="clip.mp4"><source src="clip.webm"></video>' +
          '<svg><use href="icons.svg#x"></use></svg>',
      ),
      'next.html': HTML_OBJECT('<!doctype html><p>next</p>'),
      'frame.html': HTML_OBJECT('<!doctype html><p>frame</p>'),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('href="next.html"')
    expect(html).toContain('src="frame.html"')
    expect(html).toContain('src="clip.mp4"')
    expect(html).toContain('src="clip.webm"')
    expect(html).toContain('href="icons.svg#x"')
  })

  it('escapes closing tags inside inlined css and js so they cannot break out', async () => {
    const evilCss = 'body::after { content: "</style><script>alert(1)</script>" }'
    const evilJs = 'const s = "</script><img src=x onerror=alert(1)>"'
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT(
        '<!doctype html><link rel="stylesheet" href="evil.css"><script src="evil.js"></script>',
      ),
      'evil.css': CSS_OBJECT(evilCss),
      'evil.js': JS_OBJECT(evilJs),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('<\\/style>')
    expect(html).not.toContain('"</style><script>alert(1)</script>"')
    expect(html).toContain('<\\/script>')
    expect(html).not.toContain('"</script><img src=x onerror=alert(1)>"')
  })

  it('inlines CSS url() references inside <style> and style attributes', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT(
        '<!doctype html><style>.hero { background: url("img/logo.png") }</style>' +
          '<div style="background-image:url(img/logo.png)"></div>',
      ),
      'img/logo.png': PNG_OBJECT([0x89, 0x50]),
    })

    const html = await inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store)

    expect(html).toContain('url("data:image/png;base64,')
    expect(html).not.toContain('url("img/logo.png")')
    expect(html).not.toContain('url(img/logo.png)')
  })

  it('throws ENTRY_MISSING when the entry document is not in storage', async () => {
    const { store, manifest } = storeWith({})
    await expect(
      inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store),
    ).rejects.toMatchObject({ code: 'ENTRY_MISSING' })
  })

  it('throws INTERNAL_ERROR when an inlined css asset is not valid UTF-8', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html><link rel="stylesheet" href="bad.css">'),
      'bad.css': { body: Buffer.from([0xff, 0xfe, 0xfd]), contentType: 'text/css' },
    })

    await expect(
      inlineBundle({ artifactId: ARTIFACT_ID, versionId: VERSION_ID, entryPath: ENTRY_PATH, manifest }, store),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })
})

describe('buildDownload', () => {
  const authorized = (manifest: readonly ManifestEntry[]): AuthorizedVersion => ({
    artifactId: 'artifact-1',
    versionId: 'version-1',
    entryPath: ENTRY_PATH,
    manifest,
    visibility: 'private',
    isOwner: true,
  })

  it('converts the raw entry HTML to markdown for format=md', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<h1>Titles</h1><a href="https://x.test">link</a>'),
    })

    const result = await buildDownload(authorized(manifest), 'md', store)

    expect(result.contentType).toBe('text/markdown; charset=utf-8')
    expect(result.body).toContain('Titles')
    expect(result.body).toContain('[link](https://x.test)')
  })

  it('returns inlined self-contained HTML for format=html', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html><link rel="stylesheet" href="style.css">'),
      'style.css': CSS_OBJECT('body { color: #000 }'),
    })

    const result = await buildDownload(authorized(manifest), 'html', store)

    expect(result.contentType).toBe('text/html; charset=utf-8')
    expect(result.body).toContain('<style>body { color: #000 }</style>')
  })

  it('rejects an oversize artifact with BUNDLE_TOO_LARGE before reading anything', async () => {
    const { store } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html><p>hello</p>'),
    })
    const oversized = [
      manifestEntry(ENTRY_PATH, 'text/html', 'x'),
      {
        ...manifestEntry('big.bin', 'application/octet-stream', 'y'),
        bytes: env.BUNDLE_MAX_TOTAL_BYTES + 1,
      },
    ]

    await expect(buildDownload(authorized(oversized), 'md', store)).rejects.toMatchObject({
      code: 'BUNDLE_TOO_LARGE',
    })
  })

  it('maps a missing entry to ENTRY_MISSING', async () => {
    const { store } = storeWith({})
    await expect(buildDownload(authorized([]), 'md', store)).rejects.toMatchObject({
      code: 'ENTRY_MISSING',
    })
  })

  it('maps non-UTF-8 entry bytes to INTERNAL_ERROR', async () => {
    const { store } = storeWith({
      [ENTRY_PATH]: { body: Buffer.from([0xff, 0xfe, 0xfd]), contentType: 'text/html' },
    })
    const manifest = [
      { path: ENTRY_PATH, bytes: 3, content_type: 'text/html', sha256: 'fake' },
    ]

    await expect(buildDownload(authorized(manifest), 'md', store)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    })
  })

  it('reads the entry from the artifact/version prefix', async () => {
    const { store, manifest } = storeWith({
      [ENTRY_PATH]: HTML_OBJECT('<!doctype html>'),
    })
    const getObject = vi.spyOn(store, 'getObject')
    await buildDownload(authorized(manifest), 'md', store)
    expect(getObject).toHaveBeenCalledWith(storageKey(ARTIFACT_ID, VERSION_ID, ENTRY_PATH))
  })
})