import type { ManifestEntry } from '@/lib/bundle/validate'
import { HttpError } from '@/lib/http'
import { storageKey, type FetchedObject, type ObjectStore } from '@/lib/storage/object-store'

/**
 * The `.html` download: the entry document plus every asset the browser would otherwise fetch
 * while reading it, inlined so the file opens offline.
 *
 * No HTML parser is in the dependency tree, so this works on bounded regexes. It only ever
 * rewrites four shapes — stylesheet `<link>`, `<script src>`, `<img src>` and CSS `url(...)` —
 * and only when the reference resolves to a path the manifest lists. Everything else (`<a href>`,
 * `<iframe>`, `<video>/<source>`, `<use href>`, absolute URLs) is left exactly as the author
 * wrote it, which is also what keeps the SSRF surface away: the only store key ever read is one
 * the manifest names.
 */

export interface InlineBundleInput {
  readonly artifactId: string
  readonly versionId: string
  readonly entryPath: string
  readonly manifest: readonly ManifestEntry[]
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** `entries.online.js?v=2#main` → `entries.online.js`; empty refs resolve to nothing. */
function stripQueryAndHash(ref: string): string | null {
  const withoutSuffix = ref.split(/[?#]/, 1)[0]
  return withoutSuffix === undefined || withoutSuffix === '' ? null : withoutSuffix
}

/** Absolute and scheme-ful references are somebody else's problem — never fetched. */
function isExternal(ref: string): boolean {
  return (
    ref.startsWith('http://') ||
    ref.startsWith('https://') ||
    ref.startsWith('//') ||
    ref.startsWith('data:')
  )
}

/**
 * Ref → manifest path. A reference is relative to the entry document's directory — `../` reaches
 * a sibling of the bundle root, and a leading `/` is a root-relative reference. `./` and `../`
 * segments are normalised and `../` above the root simply falls off the top.
 */
function resolveAssetRef(ref: string, entryPath: string): string {
  const rootRelative = ref.startsWith('/')
  const entryDir = entryPath.slice(0, entryPath.lastIndexOf('/') + 1)
  const source = rootRelative ? ref.replace(/^\/+/, '') : ref
  const joined = rootRelative ? source : `${entryDir}${source}`
  const segments = joined.split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

/** The manifest's exact entry for a path, or nothing. Mirrors `resolveManifestPath`. */
function manifestEntryFor(
  manifest: readonly ManifestEntry[],
  path: string,
): ManifestEntry | undefined {
  return manifest.find((entry) => entry.path === path)
}

/** Decode a text asset (css/js); malformed UTF-8 is a 500, never partial bytes in the file. */
function decodeTextAsset(body: Buffer): string {
  try {
    return UTF8.decode(body)
  } catch {
    throw new HttpError('INTERNAL_ERROR', 'asset is not valid UTF-8')
  }
}

/** One `data:` URI per manifest path, so an asset referenced twice is fetched once. */
class AssetCache {
  private readonly fetched = new Map<string, FetchedObject | undefined>()

  constructor(
    private readonly input: InlineBundleInput,
    private readonly store: ObjectStore,
  ) {}

  private async fetch(path: string): Promise<FetchedObject | undefined> {
    let object = this.fetched.get(path)
    if (object === undefined && !this.fetched.has(path)) {
      object = await this.store.getObject(
        storageKey(this.input.artifactId, this.input.versionId, path),
      )
      this.fetched.set(path, object)
    }
    return object
  }

  /** Decoded text for a css/js asset, keyed by role so the caller knows which kind it got. */
  async textFor(path: string): Promise<{ readonly css?: string; readonly js?: string } | null> {
    const entry = manifestEntryFor(this.input.manifest, path)
    if (entry === undefined) return null
    const object = await this.fetch(path)
    if (object === undefined) return null
    const text = decodeTextAsset(object.body)
    return entry.content_type === 'text/javascript' ? { js: text } : { css: text }
  }

  /** Base64 data URI for images and other binary assets. */
  async dataUriFor(path: string): Promise<string | null> {
    const entry = manifestEntryFor(this.input.manifest, path)
    if (entry === undefined) return null
    const object = await this.fetch(path)
    if (object === undefined) return null
    return `data:${entry.content_type};base64,${object.body.toString('base64')}`
  }
}

/** An asset's text must not be able to close the tag it is inlined into. */
function escapeStyleBody(css: string): string {
  return css.replaceAll('</style>', '<\\/style>')
}

function escapeScriptBody(js: string): string {
  return js.replaceAll('</script>', '<\\/script>')
}

export async function inlineBundle(
  input: InlineBundleInput,
  store: ObjectStore,
): Promise<string> {
  const assets = new AssetCache(input, store)

  const entryObject = await store.getObject(
    storageKey(input.artifactId, input.versionId, input.entryPath),
  )
  // The entry document is the reason this download exists; a missing one is a broken bundle.
  if (entryObject === undefined) {
    throw new HttpError('ENTRY_MISSING', 'artifact entry is missing')
  }

  let html = decodeTextAsset(entryObject.body)

  // 1. Stylesheet links: <link rel="stylesheet" href="..."> → <style>{css}</style>
  html = await replaceStylesheetLinks(html, input, assets)

  // 2. Scripts: <script src="..."></script> → <script>{js}</script>
  html = await replaceScriptTags(html, input, assets)

  // 3. Images: <img ... src="..."> → the src attribute becomes a data URI
  html = await replaceImageSrcs(html, input, assets)

  // 4. CSS url() everywhere — the entry's own <style>/style="", and linked stylesheets that were
  //    inlined in step 1 — so no relative ref survives in the downloaded file.
  html = await replaceCssUrls(html, input, assets)

  return html
}

/**
 * Finds every tag, then the src/href attribute, without caring which order the author wrote them
 * in. The `(?<![\w-])` guard keeps `data-src`/`data-href` out of the match.
 */
function valueOfAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`(?<![\\w-])\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag)
  return match === null ? null : (match[2] ?? '')
}

function isStylesheetLink(tag: string): boolean {
  return /(?:^|\s)rel\s*=\s*["']?stylesheet["']?/i.test(tag)
}

/** The attribute string minus its `src=...`; `data-src` is not `src` and stays. */
function withoutSrcAttribute(attributes: string): string {
  return attributes.replace(/\s*(?<![\w-])src\s*=\s*(["']).*?\1/i, '')
}

const LINK_TAG_RE = /<link\b[^>]*>/gi
const SCRIPT_TAG_RE = /<script\b([^>]*)>\s*<\/script>/gi
const IMG_TAG_RE = /<img\b[^>]*>/gi
const CSS_URL_RE = /url\(\s*["']?([^"')]+)["']?\s*\)/g

async function replaceStylesheetLinks(
  html: string,
  input: InlineBundleInput,
  assets: AssetCache,
): Promise<string> {
  return replaceAsync(html, LINK_TAG_RE, async (tag) => {
    if (!isStylesheetLink(tag)) return tag
    const href = valueOfAttribute(tag, 'href')
    if (href === null) return tag
    const ref = stripQueryAndHash(href.trim())
    if (ref === null || isExternal(ref)) return tag
    const inlined = await assets.textFor(resolveAssetRef(ref, input.entryPath))
    return inlined === null || inlined.css === undefined
      ? tag
      : `<style>${escapeStyleBody(inlined.css)}</style>`
  })
}

async function replaceScriptTags(
  html: string,
  input: InlineBundleInput,
  assets: AssetCache,
): Promise<string> {
  return replaceAsync(html, SCRIPT_TAG_RE, async (whole, attributes: string) => {
    const src = valueOfAttribute(whole, 'src')
    if (src === null) return whole
    const ref = stripQueryAndHash(src.trim())
    if (ref === null || isExternal(ref)) return whole
    const inlined = await assets.textFor(resolveAssetRef(ref, input.entryPath))
    if (inlined === null || inlined.js === undefined) return whole
    // type="module", defer, nonce survive; only src goes, the body now carries the code.
    return `<script${withoutSrcAttribute(attributes)}>${escapeScriptBody(inlined.js)}</script>`
  })
}

async function replaceImageSrcs(
  html: string,
  input: InlineBundleInput,
  assets: AssetCache,
): Promise<string> {
  return replaceAsync(html, IMG_TAG_RE, async (tag) => {
    const src = valueOfAttribute(tag, 'src')
    if (src === null) return tag
    const ref = stripQueryAndHash(src.trim())
    if (ref === null || isExternal(ref)) return tag
    const dataUri = await assets.dataUriFor(resolveAssetRef(ref, input.entryPath))
    // Rebuild the tag with the data URI, keeping every attribute and its quoting.
    if (dataUri === null) return tag
    return tag.replace(
      new RegExp(`(?<![\\w-])\\bsrc\\s*=\\s*(["']).*?\\1`, 'i'),
      (_whole, quote: string) => `src=${quote}${dataUri}${quote}`,
    )
  })
}

async function replaceCssUrls(
  html: string,
  input: InlineBundleInput,
  assets: AssetCache,
): Promise<string> {
  return replaceAsync(html, CSS_URL_RE, async (match, url: string) => {
    const ref = stripQueryAndHash(url.trim())
    if (ref === null || isExternal(ref)) return match
    const dataUri = await assets.dataUriFor(resolveAssetRef(ref, input.entryPath))
    return dataUri === null ? match : `url("${dataUri}")`
  })
}

/**
 * `String.prototype.replace` with an async replacer. `matchAll` clones the regex, so the shared
 * module-level `/g` patterns carry no `lastIndex` between two downloads running at once. Store
 * reads stay sequential per pass, which is all the parallelism this util needs.
 */
async function replaceAsync(
  html: string,
  regex: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const found = Array.from(html.matchAll(regex))
  if (found.length === 0) return html

  let out = ''
  let cursor = 0
  for (const match of found) {
    const replacement = await replacer(match[0], ...match.slice(1))
    out += html.slice(cursor, match.index)
    out += replacement
    cursor = match.index + match[0].length
  }
  out += html.slice(cursor)
  return out
}