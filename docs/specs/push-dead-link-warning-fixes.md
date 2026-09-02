# Spec — review fixes for the push dead-link warning

Target branch: `fix/push-dead-link-warning`. Head under review: `8c393d6`
("feat(push): warn on links pointing outside the bundle").

This spec describes changes only. No code in this commit.

## Scope

Two blocking findings and six non-blocking ones from the review of PR #44, split into seven
independently committable changes:

| CHG | Finding | File(s) | Blocking |
| --- | --- | --- | --- |
| CHG-1 | 3, 4, 5 — attribute pattern misses `HREF`, matches `data-href` | `packages/push-core/src/dead-links.ts` | no |
| CHG-2 | 2 — root-absolute `href` skipped, but the origin's root *is* the bundle | `packages/push-core/src/dead-links.ts` | **yes** |
| CHG-3 | probe note — `../` above the root is neither clamped nor readable | `packages/push-core/src/dead-links.ts` | no |
| CHG-4 | 1 — `--json` error contract regression, and a second full read of the bundle | `packages/cli/src/commands/push.ts`, `packages/push-core/src/{types,push}.ts` | **yes** |
| CHG-5 | 6 — the warning prints after the upload, not before | `packages/cli/src/commands/push.ts` | no |
| CHG-6 | 7 — `1 links point at files` | `packages/cli/src/commands/push.ts` | no |
| CHG-7 | 8 — `push --help` documents neither the warning nor `deadLinks` | `packages/cli/src/help.ts` | no |

Ordering rationale: CHG-1..3 are confined to `dead-links.ts` and change what the checker *finds*;
CHG-4..6 are confined to the CLI and change *when and how* the findings are reported; CHG-7 is
documentation. Applying them in order means each commit's test changes are the ones its own diff
caused. CHG-3's BEFORE block is CHG-2's AFTER — it is the only pair with a textual dependency, and
it is called out where it applies.

Baseline that must stay green: `npx vitest run tests/unit packages` — 70 files, 1101 tests; and a
clean `npx tsc --noEmit`.

---

## CHG-1 — stop `data-href` matching, start `HREF` matching

**File:** `packages/push-core/src/dead-links.ts`

### Reason

`\b` is a word boundary, and `-` is not a word character, so `\bhref` matches at the `h` of
`data-href`. Measured on `8c393d6`: `<div data-href="nope.html">` is reported as a dead link,
though no browser ever fetches it. `data-src` matches for the same reason; it is a lazy-load
convention whose value is often generated at runtime, so scanning it produces noise the user
cannot act on.

The mirror-image defect: HTML attribute names are case-insensitive but the pattern is not.
`<a HREF="gone.html">` returns `[]` on `8c393d6` — a real dead link, silently missed.

### BEFORE (line 13)

```ts
const REFERENCE_PATTERN = /\b(?:href|src)\s*=\s*["']([^"']*)["']/g
```

### AFTER

```ts
/**
 * `(?<![-\w])` rather than `\b`: `-` is not a word character, so `\b` matches inside `data-href`
 * and reports a value no browser will ever fetch. `:` stays permitted before the name, which is
 * what keeps `xlink:href` on a `<use>` — a real fetch — in scope. The `i` flag because HTML
 * attribute names are case-insensitive: `<a HREF="…">` is the same link.
 */
const REFERENCE_PATTERN = /(?<![-\w])(?:href|src)\s*=\s*["']([^"']*)["']/gi
```

### Also in CHG-1 — record what a regex scan cannot see

Findings 4 and half of 5 are documented rather than fixed. Append one paragraph to the existing
`findDeadLinks` doc comment (`dead-links.ts:47-53`), immediately before its closing `*/`, leaving
every existing line of that comment untouched:

```
 *
 * A scan, not a parse, and warn-only for that reason. It reads markup a browser would never
 * execute — a reference inside an html comment or a `<script>` string literal is reported — and
 * it misses an unquoted `href=gone.html`, a value built at runtime, and `srcset`. A parser would
 * fix the first two, nothing would fix the third, and none of it can fail a push.
```

### Blast radius

- `data-href` / `data-src` references stop being reported. Nothing else in the repo reads
  `REFERENCE_PATTERN`.
- Lookbehind assertions need Node 16.4+; the CLI already requires far newer (`node:util`
  `parseArgs` with `tokens`, `AbortSignal.timeout`). No runtime risk.
- `xlink:href` keeps matching, deliberately: `<use xlink:href="icons.svg#icon">` is a genuine
  fetch of `icons.svg`, and the existing `#` strip already reduces it to the file. **Ship as is —
  no change needed for that probe result.**

### Recommendations for the non-blocking findings folded in here

- Finding 3 (`data-href`): **ship.** It is a false positive on a warn-only path, which is the
  worst kind — it trains the user to ignore the whole block.
- Finding 4 (comments and `<script>` strings): **ship the doc paragraph, skip the parser.** An
  HTML parser is a dependency and a new failure mode for a check that cannot fail the push.
- Finding 5 (`i` flag): **ship the flag; skip unquoted values.** Unquoted values need a different
  terminator rule (whitespace or `>`), and `href=gone.html>` would then have to be trimmed. The
  doc paragraph records the gap.

---

## CHG-2 — resolve a root-absolute reference against the bundle root

**File:** `packages/push-core/src/dead-links.ts`

### Reason

`dead-links.ts:19` treats any leading `/` as "may be served by a route". On an artifact origin
there are no other routes. `proxy.ts` `handleArtifactOrigin` rewrites **every** pathname to
`${base}/serve${pathname}`, with exactly one exception — `ARTIFACT_ENTER_PATH` (`/__enter`). The
serve route joins the path segments and hands the result to `resolveManifestPath`, which is an
exact `find` with no normalisation and no prefix fallback. So `<a href="/REPORT.html">` requests
manifest path `REPORT.html`, misses, and renders the nameless "no longer available" page this PR
exists to prevent.

Measured on `8c393d6`: `findDeadLinks([file('index.html', '<a href="/REPORT.html">r</a>')])`
returns `[]`.

### Exact resolution rule after this change

| Reference | Treated as | Result |
| --- | --- | --- |
| `/REPORT.html` | bundle-root-relative → `REPORT.html` | checked against the manifest; reported if absent |
| `/docs/index.html` | bundle-root-relative → `docs/index.html` | checked |
| `//cdn/x.js` | protocol-relative, another origin | skipped |
| `/` | the origin root; the serve route substitutes `entryPath`, and a bundle without `index.html` is already refused by `assertBundlePushable` | skipped (caught by the existing trailing-`/` guard) |
| `/docs/` | directory reference | skipped — directory-index behaviour is the server's business, exactly as the existing doc comment says of the relative case |
| `/__enter` | the one reserved path on an artifact origin | skipped |
| `/api/thing` | bundle-root-relative → `api/thing` | **now reported** — there is no `/api` on an artifact origin |
| `#top`, `https://…`, `mailto:…` | unchanged | skipped |

`/api/thing` flipping from skipped to reported is the one behaviour change a user could notice.
It is correct: that path 404s on the origin. It is also pinned by an existing test, which CHG-2
must change (see Test changes).

### BEFORE (lines 15-45)

```ts
/** `:` before the first `/` is the whole scheme test: `https:` and `mailto:` both pass it, and a
 *  relative path never contains `:`. A leading `/` — `//` included — may be served by a route. */
function isExternalReference(reference: string): boolean {
  if (reference.startsWith('#')) return true
  if (reference.startsWith('/')) return true
  const colonIndex = reference.indexOf(':')
  const slashIndex = reference.indexOf('/')
  return colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)
}

/**
 * The origin's directory-index behaviour is the server's business, not this check's: a reference
 * that points at a directory rather than a file is skipped, and one that walks above the bundle
 * root resolves to nothing in the manifest, which is reported like any other miss.
 */
function resolveReference(from: string, reference: string): string | null {
  const stripped = reference.split(/[?#]/, 1)[0]
  if (
    stripped === undefined ||
    stripped === '' ||
    stripped.endsWith('/') ||
    stripped === '.' ||
    stripped === '..'
  ) {
    return null
  }
  const directory = from.slice(0, from.lastIndexOf('/') + 1)
  const resolved = posix.normalize(directory + stripped)
  if (resolved === '' || resolved === '.' || resolved.endsWith('/')) return null
  return resolved
}
```

### AFTER

```ts
/**
 * The one path on an artifact origin that is reserved rather than served from the bundle. Copied
 * from `src/lib/artifacts/origin.ts` rather than imported: that module pulls in `@/env`, which
 * validates server environment on import and has no business inside the CLI.
 */
const ORIGIN_RESERVED_PATH = '/__enter'

/** `:` before the first `/` is the whole scheme test: `https:` and `mailto:` both pass it, and a
 *  relative path never contains `:`. `//host/x` is another origin; a *single* leading `/` is not.
 *  The proxy rewrites every artifact-origin path onto the bundle, so the root is the bundle. */
function isExternalReference(reference: string): boolean {
  if (reference.startsWith('#')) return true
  if (reference.startsWith('//')) return true
  const colonIndex = reference.indexOf(':')
  const slashIndex = reference.indexOf('/')
  return colonIndex !== -1 && (slashIndex === -1 || colonIndex < slashIndex)
}

/**
 * The origin's directory-index behaviour is the server's business, not this check's: a reference
 * that points at a directory rather than a file is skipped, `/` included — the serve route answers
 * it with the manifest's entry path, which every pushable bundle has.
 *
 * A root-absolute reference resolves against the bundle root, not the referring file's directory,
 * because that is what the proxy does with it: every pathname but `/__enter` is rewritten onto
 * `/serve<pathname>` and matched against the manifest exactly.
 */
function resolveReference(from: string, reference: string): string | null {
  const stripped = reference.split(/[?#]/, 1)[0]
  if (
    stripped === undefined ||
    stripped === '' ||
    stripped.endsWith('/') ||
    stripped === '.' ||
    stripped === '..' ||
    stripped === ORIGIN_RESERVED_PATH
  ) {
    return null
  }
  const isRootAbsolute = stripped.startsWith('/')
  const directory = isRootAbsolute ? '' : from.slice(0, from.lastIndexOf('/') + 1)
  const resolved = posix.normalize(directory + (isRootAbsolute ? stripped.slice(1) : stripped))
  if (resolved === '' || resolved === '.' || resolved.endsWith('/')) return null
  return resolved
}
```

### Blast radius

- Warn-only output. No push is refused, no exit code changes.
- Bundles that link `/assets/app.css` from a nested page now get a *correct* warning where they
  previously got silence. Bundles that link non-bundle root paths (`/api/…`, `/health`) now get a
  warning; those links are dead on the origin, so the warning is accurate.
- Adds a second copy of the `/__enter` literal. See Risks.

---

## CHG-3 — clamp a reference that walks above the root

**File:** `packages/push-core/src/dead-links.ts`. **BEFORE below is CHG-2's AFTER; apply after
CHG-2.**

### Reason

`posix.normalize` keeps leading `..` segments, so `docs/a.html` + `../../x.html` resolves to
`../x.html`. Two consequences:

1. The warning prints `docs/a.html → ../x.html`, which reads as a filesystem path rather than as
   the address the browser will request.
2. It is a **false positive**. A browser clamps `..` at the origin root: from `/docs/a.html`,
   `../../x.html` is a request for `/x.html`. If `x.html` is in the bundle, the link works and the
   checker reports it dead anyway.

`../../etc/passwd` from the root stays reported, correctly — it becomes a request for
`/etc/passwd`, which no manifest lists.

### BEFORE

```ts
  const isRootAbsolute = stripped.startsWith('/')
  const directory = isRootAbsolute ? '' : from.slice(0, from.lastIndexOf('/') + 1)
  const resolved = posix.normalize(directory + (isRootAbsolute ? stripped.slice(1) : stripped))
  if (resolved === '' || resolved === '.' || resolved.endsWith('/')) return null
  return resolved
}
```

### AFTER

```ts
  const isRootAbsolute = stripped.startsWith('/')
  const directory = isRootAbsolute ? '' : from.slice(0, from.lastIndexOf('/') + 1)
  const resolved = clampToRoot(
    posix.normalize(directory + (isRootAbsolute ? stripped.slice(1) : stripped)),
  )
  if (resolved === '' || resolved === '.' || resolved.endsWith('/')) return null
  return resolved
}
```

with this added directly above `resolveReference`:

```ts
/**
 * A browser clamps `..` at the origin root: from `/docs/a.html`, `../../x.html` is a request for
 * `/x.html`. `posix.normalize` keeps the `../` prefix instead, which both reads as a filesystem
 * path in the warning and reports dead a link that in fact resolves onto a file the bundle has.
 */
function clampToRoot(path: string): string {
  let clamped = path
  while (clamped.startsWith('../')) clamped = clamped.slice(3)
  return clamped === '..' ? '' : clamped
}
```

### Blast radius

- Confined to references containing enough `..` to leave the root. Everything else normalises the
  same as before.
- Turns one class of false positive into silence and makes the rest of that class print the path
  the browser actually requests.
- **Recommendation: ship.** The review filed this as a message-cosmetics question; it is a
  correctness fix, and the cosmetics come free.

---

## CHG-4 — collect the bundle once, inside the `--json` error contract

**Files:** `packages/cli/src/commands/push.ts`, `packages/push-core/src/types.ts`,
`packages/push-core/src/push.ts`

### Reason (blocking)

`packages/cli/src/commands/push.ts:465` calls `collectBundle(options.directory)` outside every
try/catch on the non-dry-run path. On `main`, `collectBundle` only ever ran inside `push()`, whose
throw was caught at ~488 and turned by `reportError` into `{"error":{code,message}}` on stderr with
exit 1. Now an fs failure — EACCES, or ENOENT for a file removed between the walk and the read —
escapes `runPush` as a rejected promise. `main()` rethrows anything that is not a `UsageError`, and
`bin.ts`'s `.catch` prints `error.message` as a bare line. So a `--json` caller gets prose on
stderr instead of the error envelope it was promised, and any in-process caller of `runPush`
(the CLI test suite included) gets a rejection instead of an exit code.

Measured on the same directory, one `a.css` at mode 000, `--json`, non-dry-run:

- `main`: `exit=1`, stderr `{"error":{"code":"UNEXPECTED_RESPONSE","message":"EACCES: ..."}}`
- `8c393d6`: throws out of `runPush`; stdout and stderr both empty

Secondary cost: the directory is walked and fully read twice — up to the advertised 10 MB — on the
one path that is about to make a network call with it.

### Options considered

**(a) `push()` accepts an already-collected bundle. — CHOSEN.**
The CLI collects once, inside a try/catch it already owns; it computes dead links from that
bundle; it hands the same bundle to `push()`. One read, the error contract is restored by the
CLI's existing `reportError`, and the findings exist *before* the request — which is what CHG-5
needs.

**(b) `PushResult` gains `deadLinks`, computed in push-core. — REJECTED.**
The findings would only exist once `push()` has resolved, i.e. once the version is live. That
makes finding 6 unfixable by construction: the PR body promises the warning lands "before it
ships". It also puts an HTML-scanning concern inside the network client and does nothing for the
dry-run path, which never calls `push()` — `findDeadLinks` would still be invoked from two places.

**(c) Wrap lines 465-466 in the same try/catch + `reportError`. — REJECTED as insufficient.**
It fixes the error envelope and nothing else. The bundle is still read twice, and the comment at
463-464 that excuses the second read ("a few files off local disk") stays wrong at the 10 MB
ceiling the help text advertises. (a) costs one optional field and deletes that excuse.

### Change 4a — `packages/push-core/src/types.ts`

#### BEFORE (line 14)

```ts
export type Visibility = 'private' | 'org' | 'public'
```

#### AFTER

```ts
import type { CollectResult } from './collect.ts'

export type Visibility = 'private' | 'org' | 'public'
```

(`collect.ts` already imports from `types.ts` type-only, so both directions erase at compile time
and no runtime cycle exists.)

#### BEFORE (lines 32-36)

```ts
  readonly isInsecureAllowed?: boolean
  readonly userAgent?: string
  /** `push` already holds the files, so a caller announcing the upload need not re-read the directory. */
  readonly onUploadStart?: (plan: UploadPlan) => void
}
```

#### AFTER

```ts
  readonly isInsecureAllowed?: boolean
  readonly userAgent?: string
  /** The bundle, already collected. A caller that had to read the directory for its own checks
   *  passes it here rather than making `push` walk and read all of it a second time. Omitted =>
   *  `push` collects `directory` itself, which is the standalone case. */
  readonly bundle?: CollectResult
  /** `push` already holds the files, so a caller announcing the upload need not re-read the directory. */
  readonly onUploadStart?: (plan: UploadPlan) => void
}
```

### Change 4b — `packages/push-core/src/push.ts`

#### BEFORE (lines 107-109)

```ts
export async function push(options: PushOptions): Promise<PushResult> {
  const { files, skipped } = collectBundle(options.directory)
  assertBundlePushable(files, skipped)
```

#### AFTER

```ts
export async function push(options: PushOptions): Promise<PushResult> {
  // Validation runs on the bundle whoever produced it: a caller that pre-collected does not get a
  // laxer check than one that did not.
  const { files, skipped } = options.bundle ?? collectBundle(options.directory)
  assertBundlePushable(files, skipped)
```

### Change 4c — `packages/cli/src/commands/push.ts`

Add `CollectResult` to the existing type import (lines 13-19):

#### BEFORE

```ts
import type {
  DeadLink,
  PushResult,
  SkippedFile,
  SkipReason,
  UploadPlan,
} from '../../../push-core/src/index.ts'
```

#### AFTER

```ts
import type {
  CollectResult,
  DeadLink,
  PushResult,
  SkippedFile,
  SkipReason,
  UploadPlan,
} from '../../../push-core/src/index.ts'
```

Add one helper directly below `refuseUnusableDirectory` (lines 153-170), whose own doc comment
already describes this class of bug — "`collectBundle` throws a raw fs error from outside every
`--json` branch":

```ts
/**
 * The bundle, or an exit code. `refuseUnusableDirectory` catches a missing or non-directory path;
 * what is left is a file that exists and cannot be read — mode 000, or deleted between the walk
 * and the read. That throw used to reach the network catch, which is the whole reason `--json`
 * once reported a local fs failure as `UNEXPECTED_RESPONSE`; escaping `runPush` entirely is worse,
 * because then stderr carries a bare line instead of the error object `--json` promises.
 */
function collectOrReport(options: PushCommandOptions): CollectResult | number {
  try {
    return collectBundle(options.directory)
  } catch (error) {
    const text = messageOf(error)
    reportError(options.isJson, 'UNREADABLE_DIRECTORY', text, `✗ ${text}`)
    return 1
  }
}
```

Use it on the dry-run path:

#### BEFORE (lines 253-256)

```ts
function reportDryRun(options: PushCommandOptions): number {
  const bundle = collectBundle(options.directory)

  try {
```

#### AFTER

```ts
function reportDryRun(options: PushCommandOptions): number {
  const bundle = collectOrReport(options)
  if (typeof bundle === 'number') return bundle

  try {
```

and on the real push path:

#### BEFORE (lines 461-473)

```ts
  const isProgressVisible = !options.isJson

  // `push()` collects internally and holds no files, so the dead-link check that needs them reads
  // the directory once more — a few files off local disk, and it stays out of the network path.
  const bundle = collectBundle(options.directory)
  const deadLinks = findDeadLinks(bundle.files)

  let result: PushResult
  try {
    result = await push({
      directory: options.directory,
      host: canonicalHost,
      token,
```

#### AFTER

```ts
  const isProgressVisible = !options.isJson

  // The only read of the directory on this path: the dead-link check needs the files and `push`
  // takes the same bundle, so a 10 MB tree is not walked and read twice on the way to one request.
  const bundle = collectOrReport(options)
  if (typeof bundle === 'number') return bundle
  const deadLinks = findDeadLinks(bundle.files)

  let result: PushResult
  try {
    result = await push({
      directory: options.directory,
      bundle,
      host: canonicalHost,
      token,
```

### Blast radius

- `runPush` no longer rejects for a local read failure on either path; it returns 1 with the
  `--json` envelope or the `✗ …` line, matching every other failure in the command.
- The dry-run path gets the same guard. On `main` it was equally unguarded, so that half is not a
  regression fix but the same defect in its second location; it can be dropped if the reviewer
  wants the commit narrowed to the finding.
- New error code string `UNREADABLE_DIRECTORY`. `main` emitted `UNEXPECTED_RESPONSE` here, which
  the code's own comment calls a misreport. See Open questions if codes are treated as frozen.
- `push()` keeps working for a caller that passes only `directory`, so `packages/push-core/push.test.ts`
  needs no change; and every `expect(push).toHaveBeenCalledWith(...)` in the CLI suite uses
  `objectContaining` / `toMatchObject`, so the new `bundle` field breaks none of them.
- One read means one snapshot: a file changed between the two old reads could previously produce a
  warning about content that was not uploaded. That inconsistency is gone.

---

## CHG-5 — warn before the upload, not after it

**File:** `packages/cli/src/commands/push.ts`. Apply after CHG-4.

### Reason

`deadLinks` is computed at ~466 but `writeDeadLinkBlock` is not called until ~521, after `push()`
has resolved and the version exists on the server. The PR body promises the warning arrives
"before it ships", and the dry-run path already does exactly that. As written, on a real push it
is a post-mortem.

### BEFORE (CHG-4's AFTER)

```ts
  const bundle = collectOrReport(options)
  if (typeof bundle === 'number') return bundle
  const deadLinks = findDeadLinks(bundle.files)

  let result: PushResult
```

### AFTER

```ts
  const bundle = collectOrReport(options)
  if (typeof bundle === 'number') return bundle
  const deadLinks = findDeadLinks(bundle.files)
  // Before the request, not after it: a warning that arrives once the version exists is a
  // post-mortem. Under --json the same findings ride in the result object instead.
  if (!options.isJson) writeDeadLinkBlock(deadLinks)

  let result: PushResult
```

and remove the trailing call:

#### BEFORE (lines 521-523)

```ts
  writeDeadLinkBlock(deadLinks)
  reportPushed(options, canonicalHost, result, republishTarget !== null)
  return 0
}
```

#### AFTER

```ts
  reportPushed(options, canonicalHost, result, republishTarget !== null)
  return 0
}
```

### Blast radius

- The warning now also prints when the push subsequently *fails*, ahead of the `✗ …` line. That is
  the right order for a warn-then-error stream and matches `announceUpload`, which is likewise
  emitted before the outcome is known.
- Ordering on a successful non-`--json` push becomes: `warning:` block → `uploading …` → `✓` lines.
- No behaviour change under `--json`: `writeDeadLinkBlock` was already unreachable there, and the
  `isJson` guard is now explicit at the call site rather than implicit in the control flow.

---

## CHG-6 — singular and plural

**File:** `packages/cli/src/commands/push.ts`

### Reason

`warning: 1 links point at files not in this bundle:` — and the single-link case is the common one.

### BEFORE (lines 78-83)

```ts
function writeDeadLinkBlock(deadLinks: readonly DeadLink[]): void {
  if (deadLinks.length === 0) return
  const fromColumnWidth = deadLinks.reduce((widest, link) => Math.max(widest, link.from.length), 0)
  process.stderr.write(
    `warning: ${String(deadLinks.length)} links point at files not in this bundle:\n`,
  )
```

### AFTER

```ts
function writeDeadLinkBlock(deadLinks: readonly DeadLink[]): void {
  if (deadLinks.length === 0) return
  const fromColumnWidth = deadLinks.reduce((widest, link) => Math.max(widest, link.from.length), 0)
  const count = deadLinks.length
  process.stderr.write(
    count === 1
      ? 'warning: 1 link points at a file not in this bundle:\n'
      : `warning: ${String(count)} links point at files not in this bundle:\n`,
  )
```

### Blast radius

- One pinned string, at `packages/cli/push-command.test.ts:445` (see Test changes).
- `writeSkippedBlock` keeps saying `skipped 1 files:`. Out of scope for this PR — raised in Open
  questions rather than fixed here, so the diff stays reviewable against the review.

---

## CHG-7 — document the warning and the `deadLinks` payload

**File:** `packages/cli/src/help.ts` (`PUSH_HELP`)

### Reason

`push --help` is the only documentation at the terminal, and it mentions neither the new stderr
warning nor the `deadLinks` array that `--json` now emits on both a dry run and a real push. A
`--json` consumer reading the help has no way to learn the field exists.

### BEFORE

```
  --dry-run    print what would be uploaded and skipped, and make no request
${JSON_FLAG}${HOST_FLAGS}
What goes up:
```

### AFTER

```
  --dry-run    print what would be uploaded and skipped, and make no request
${JSON_FLAG}${HOST_FLAGS}
Dead links: every html file in the bundle is scanned for href and src values,
and any that resolves to a path the bundle does not hold is printed to stderr
before anything is uploaded. It is advice, never a refusal — the push goes
ahead. Under --json the same findings are in the result object instead, as
deadLinks: [{from, to}], on a dry run and on a real push alike. A leading /
is resolved against the bundle root, because on an artifact origin the root is
the bundle; off-site addresses, fragments and directory paths are left alone.

What goes up:
```

### Blast radius

- `packages/cli/main.test.ts:218` asserts on `push --help` with `toContain` only, so added text
  cannot break it. One assertion is added there (see Test changes).
- `JSON_FLAG` and `HOST_FLAGS` are shared with every other topic and are not touched.

---

## Test changes

### Existing tests that must change

| File:line | Change | Caused by |
| --- | --- | --- |
| `packages/push-core/dead-links.test.ts:44` | Delete the line `'<a href="/api/thing">api</a>',` from the markup in `ignores references the origin will serve elsewhere or not at all`. A root-absolute path is no longer "served elsewhere" — there is no `/api` on an artifact origin, so it is now reported. The remaining five entries (`#top`, `https:`, `mailto:`, `//cdn/x.js`, `""`) keep asserting `[]`. | CHG-2 |
| `packages/cli/push-command.test.ts:445` | `expect(stderr).toContain('warning: 1 links point at files not in this bundle:')` becomes `expect(stderr).toContain('warning: 1 link points at a file not in this bundle:')` | CHG-6 |

Nothing else changes. In particular `push-command.test.ts:565` and `:910`
(`{...SUCCESS_RESULT, deadLinks: []}`) stay exactly as they are — the fixture `index.html` holds no
references — and `packages/push-core/push.test.ts` needs no edit because `bundle` is optional.

### Test-harness change required by the new `--json` error test

`packages/cli/push-command.test.ts:18-21` currently mocks push-core as:

```ts
vi.mock('../push-core/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PushCoreModule>()
  return { ...actual, push: vi.fn() }
})
```

Make `collectBundle` mockable while defaulting to the real implementation, so only the test that
wants a failure sees one:

```ts
const { collectBundle: realCollectBundle } =
  await vi.importActual<typeof PushCoreModule>('../push-core/src/index.ts')

vi.mock('../push-core/src/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof PushCoreModule>()
  return { ...actual, push: vi.fn(), collectBundle: vi.fn() }
})
```

with `collectBundle` added to the value import from `'../push-core/src/index.ts'` (line 9), plus,
in the existing `beforeEach` beside `vi.mocked(push).mockResolvedValue(SUCCESS_RESULT)`:

```ts
vi.mocked(collectBundle).mockImplementation(realCollectBundle)
```

and in the existing `afterEach` beside `vi.mocked(push).mockReset()`:

```ts
vi.mocked(collectBundle).mockReset()
```

Re-installing the implementation per test keeps it independent of whether `vi.restoreAllMocks()`
clears a factory `vi.fn()`. A real mode-000 file was rejected as the trigger: CI running as root
reads it anyway, and the test would silently stop covering the finding.

### New tests — `packages/push-core/dead-links.test.ts`

1. `it('resolves a root-absolute reference against the bundle root, which is what the origin serves')`
   — **fails on `8c393d6`** (the first assertion gets `[]`). This is the pin for finding 2.

   ```ts
   expect(findDeadLinks([file('index.html', '<a href="/REPORT.html">r</a>')])).toEqual([
     { from: 'index.html', to: 'REPORT.html' },
   ])
   expect(
     findDeadLinks([
       file('docs/a.html', '<a href="/index.html">home</a>'),
       file('index.html', '<!doctype html>'),
     ]),
   ).toEqual([])
   ```

2. `it('leaves the other leading-slash shapes alone')` — passes on `8c393d6`; it is the guard that
   CHG-2 does not over-reach.

   ```ts
   const markup = [
     '<a href="//cdn/x.js">cdn</a>',
     '<a href="/__enter">enter</a>',
     '<a href="/">home</a>',
     '<a href="/docs/">docs</a>',
   ].join('\n')
   expect(findDeadLinks([file('index.html', markup)])).toEqual([])
   ```

3. `it('ignores an attribute whose name merely ends in href or src')` — **fails on `8c393d6`**
   (reports both).

   ```ts
   expect(
     findDeadLinks([
       file('index.html', '<div data-href="nope.html"></div><img data-src="late.png">'),
     ]),
   ).toEqual([])
   ```

4. `it('matches attribute names case-insensitively, as html does')` — **fails on `8c393d6`**
   (returns `[]`).

   ```ts
   expect(findDeadLinks([file('index.html', '<a HREF="gone.html">gone</a>')])).toEqual([
     { from: 'index.html', to: 'gone.html' },
   ])
   ```

5. `it('reports the path the browser would request when a reference walks above the root')` —
   **fails on `8c393d6`** (first gives `../etc/passwd`; second is a false positive).

   ```ts
   expect(findDeadLinks([file('docs/a.html', '<a href="../../etc/passwd">x</a>')])).toEqual([
     { from: 'docs/a.html', to: 'etc/passwd' },
   ])
   expect(
     findDeadLinks([
       file('docs/a.html', '<a href="../../index.html">home</a>'),
       file('index.html', '<!doctype html>'),
     ]),
   ).toEqual([])
   ```

6. `it('checks xlink:href, which is a real fetch on a <use>')` — passes on `8c393d6`; added by
   CHG-1 as the pin that the lookbehind does not exclude a `:`-prefixed name.

   ```ts
   expect(
     findDeadLinks([file('index.html', '<svg><use xlink:href="icons.svg#star"/></svg>')]),
   ).toEqual([{ from: 'index.html', to: 'icons.svg' }])
   ```

### New tests — `packages/cli/push-command.test.ts`

7. `it('reports an unreadable directory in the --json error envelope, not as a bare throw')` —
   **fails on `8c393d6`**: `runPush` rejects, so the `await` throws before any assertion runs.
   This is the pin for finding 1.

   ```ts
   vi.mocked(collectBundle).mockImplementationOnce(() => {
     throw new Error(`EACCES: permission denied, open '${join(projectDirectory, 'a.css')}'`)
   })

   const exitCode = await runPush({
     directory: projectDirectory,
     host: HOST,
     isNew: false,
     isForced: false,
     isDryRun: false,
     isJson: true,
   })

   expect(exitCode).toBe(1)
   expect(push).not.toHaveBeenCalled()
   expect(stdout).toBe('')
   expect(JSON.parse(stderr) as { readonly error: { code: string; message: string } }).toEqual({
     error: { code: 'UNREADABLE_DIRECTORY', message: expect.stringContaining('EACCES') },
   })
   ```

8. `it('reports an unreadable directory on the dry-run path too')` — **fails on `8c393d6`** for the
   same reason. Same body with `isDryRun: true`, same four expectations.

9. `it('hands push the bundle it already read rather than making it read the tree again')` — the
   first assertion passes on `8c393d6` (the second read happens inside the mocked `push`, so it
   never runs), the second **fails** (`bundle` is `undefined`).

   ```ts
   await runPush({
     directory: projectDirectory,
     host: HOST,
     isNew: false,
     isForced: false,
     isDryRun: false,
     isJson: false,
   })

   expect(vi.mocked(collectBundle)).toHaveBeenCalledTimes(1)
   expect(vi.mocked(push).mock.calls[0]?.[0]?.bundle?.files.map((file) => file.path)).toEqual([
     'index.html',
   ])
   ```

10. `it('warns about dead links before the upload, not after the version exists')` — **fails on
    `8c393d6`** (`stderrWhenPushCalled` is empty).

    ```ts
    writeFileSync(join(projectDirectory, 'index.html'), '<a href="gone.html">gone</a>')
    let stderrWhenPushCalled = ''
    vi.mocked(push).mockImplementation(async () => {
      stderrWhenPushCalled = stderr
      return SUCCESS_RESULT
    })

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: false,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(stderrWhenPushCalled).toContain('warning: 1 link points at a file not in this bundle:')
    expect(stderrWhenPushCalled).toContain('index.html → gone.html')
    ```

11. `it('warns about a root-absolute link the bundle cannot satisfy')` — **fails on `8c393d6`**
    (stderr holds no warning). End-to-end pin for finding 2.

    ```ts
    writeFileSync(join(projectDirectory, 'index.html'), '<a href="/REPORT.html">report</a>')

    const exitCode = await runPush({
      directory: projectDirectory,
      host: HOST,
      isNew: false,
      isForced: false,
      isDryRun: true,
      isJson: false,
    })

    expect(exitCode).toBe(0)
    expect(stderr).toContain('warning: 1 link points at a file not in this bundle:')
    expect(stderr).toContain('index.html → REPORT.html')
    ```

12. `it('counts links in the plural only when there is more than one')` — **fails on `8c393d6`**
    (prints `2 links point at files` correctly, but the singular half of this pair is the amended
    assertion at `:445`, which fails there).

    ```ts
    writeFileSync(
      join(projectDirectory, 'index.html'),
      '<a href="gone.html">a</a><img src="missing.png">',
    )

    expect(
      await runPush({
        directory: projectDirectory,
        host: HOST,
        isNew: false,
        isForced: false,
        isDryRun: true,
        isJson: false,
      }),
    ).toBe(0)
    expect(stderr).toContain('warning: 2 links point at files not in this bundle:')
    ```

### New assertion — `packages/cli/main.test.ts`

13. In `it('answers push with the rules that exist nowhere else at the terminal')` (~line 218), add
    to the existing `toContain` chain — **fails on `8c393d6`**:

    ```ts
    expect(topic).toContain('deadLinks')
    ```

### Expected suite total afterwards

70 files, 1101 + 12 = **1113 tests** (12 new cases; item 13 adds an assertion to an existing case).

---

## Risks

- **`/api/thing` flips from silent to warned (CHG-2).** Anyone whose bundle links out to an app
  route on the parent origin with a root-absolute path now gets a warning on every push. The
  warning is factually right — that request 404s on the artifact origin — but it is new noise for
  an existing user. It is warn-only, so it cannot break a pipeline. Worth a line in the PR body.
- **`/__enter` is now written down in two places** — `src/lib/artifacts/origin.ts` and
  `dead-links.ts`. If the reserved path is ever renamed, the checker starts warning about it.
  Importing the real constant is not an option: `origin.ts` imports `@/env`, which validates server
  environment at import time and would be pulled into the CLI. The comment in CHG-2's AFTER names
  the source of truth; a shared constants module is the real fix and is out of scope here.
- **Lookbehind in `REFERENCE_PATTERN` (CHG-1)** is ES2018. Fine for every Node the CLI supports,
  but if push-core is ever bundled for an old JS target the regex fails to compile at parse time,
  not at match time — a hard failure rather than a degraded check.
- **`data-src` stops being scanned (CHG-1).** A bundle that lazy-loads every image through
  `data-src` loses image coverage entirely. Judged the right trade for a warn-only check: a false
  positive gets the whole block ignored, a false negative costs one missed warning.
- **New error code `UNREADABLE_DIRECTORY` (CHG-4)** is not what `main` emitted here
  (`UNEXPECTED_RESPONSE`). Any script matching on the old code for this case sees something new.
  Judged acceptable — a local fs failure reported as an unexpected *response* is the exact
  misreport that `refuseUnusableDirectory`'s doc comment was written to complain about.
- **`push()` now trusts a caller-supplied bundle (CHG-4).** `assertBundlePushable` still runs on
  it, so nothing invalid reaches the wire; but a caller could pass a bundle collected from a
  different directory than `options.directory`. Only the CLI calls `push()`, and it passes the
  bundle it just collected from that same path.
- **The warning is emitted even when the push then fails (CHG-5).** Intentional, and consistent
  with `announceUpload`, but it does mean a failed push prints a warning about a version that
  never came to exist.

## Open questions

1. **Is the `--json` `error.code` set a frozen contract?** If it is, CHG-4 should use
   `UNEXPECTED_RESPONSE` to reproduce `main` byte-for-byte instead of `UNREADABLE_DIRECTORY`, and
   test 7 changes with it. Nothing else in CHG-4 is affected. Recommendation:
   `UNREADABLE_DIRECTORY`, because the code is the only machine-readable part of that envelope and
   the old value was wrong.
2. **Should the dry-run half of CHG-4 ship in this PR?** It fixes the identical unguarded
   `collectBundle` in `reportDryRun`, which is pre-existing on `main` rather than a regression from
   this PR. Recommendation: ship — it is four lines and the helper exists either way — but it is a
   clean thing to split out if the reviewer wants the commit to match the finding exactly.
3. **`skipped 1 files:` has the same singular problem as CHG-6** and sits four functions away in
   the same file. Left alone deliberately: it is not this PR's string, and changing it moves
   `push-command.test.ts:409` too. Fix in a follow-up, or say the word and it joins CHG-6.
4. **Percent- and entity-encoded references are reported, and stay that way.** `my%20page.html` is
   not percent-decoded and `a&amp;b.html` is not entity-decoded, so both are reported. Checked
   against `PATH_PATTERN` in `src/lib/bundle/rules.ts` — `/^[a-zA-Z0-9._\-/]{1,200}$/`, which
   admits neither a space, a `%`, nor an `&`. So a bundle can never contain `my page.html`,
   `my%20page.html` or `a&b.html`: the reference really is dead and the report is correct, even
   though the reasoning that produced it is not. The false positive the review worried about is
   unreachable. **No change proposed** — confirm the reviewer agrees before this is closed as
   "correct by accident".
5. **`Page.html` vs `page.html` is case-sensitive and stays that way.** `resolveManifestPath` is an
   exact `find`, so the checker matching the manifest's own case rules is correct on every
   platform — including the case-insensitive macOS filesystem a user may have authored on, where
   the link works locally and 404s on the origin. Recorded here because it will look like a bug to
   whoever hits it. **No change proposed.**
6. **`srcset` is not scanned.** It is a comma-separated descriptor list, so it needs its own
   parser, and its values are normally generated. Left out; say so if it should be in scope.
7. **`/docs/` (root-absolute, trailing slash) is skipped, and it is genuinely dead** — the serve
   route joins to `docs/` and the manifest never lists a trailing slash. Skipped for consistency
   with the relative directory case the existing doc comment calls the server's business. If
   directory references should be reported at all, that is one rule change covering both cases, and
   it is deliberately not in this spec.

---

## Verification

Run from the worktree root, with the project's Node toolchain on `PATH`:

```
npx vitest run tests/unit packages
npx tsc --noEmit
npx eslint packages/push-core/src/dead-links.ts packages/push-core/src/types.ts packages/push-core/src/push.ts packages/cli/src/commands/push.ts packages/cli/src/help.ts packages/push-core/dead-links.test.ts packages/cli/push-command.test.ts packages/cli/main.test.ts
```

Expected:

- `vitest`: 70 files, 1113 tests, all passing. (Baseline on `8c393d6`: 70 files, 1101 tests.)
- `tsc --noEmit`: clean, as on `8c393d6`.
- `eslint`: clean on every changed file.

Per-change spot checks, each of which must fail before its change and pass after:

```
npx vitest run packages/push-core/dead-links.test.ts     # CHG-1, CHG-2, CHG-3
npx vitest run packages/cli/push-command.test.ts         # CHG-4, CHG-5, CHG-6
npx vitest run packages/cli/main.test.ts                 # CHG-7
```

Manual check for the finding-1 regression, on a directory holding an `index.html` and one
unreadable file, with a token in `ENCLAVE_TOKEN`:

```
chmod 000 <dir>/a.css
enclave push <dir> --host <host> --json ; echo "exit=$?"
```

Expected after CHG-4: `exit=1`, stdout empty, stderr a single line of JSON parsing to
`{"error":{"code":"UNREADABLE_DIRECTORY","message":"EACCES: ..."}}`. On `8c393d6` this prints a
bare `EACCES: …` line instead. Skip if the shell is root, which reads the file regardless — test 7
covers the same path deterministically.
