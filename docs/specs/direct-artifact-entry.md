# Direct artifact entry

Status: proposed. Scope: the artifact origin's response when a viewer arrives without a usable
grant cookie.

This document cites `grill-result` section numbers the way the source comments do (§4.1, §4.2, §4.3,
§5.1, §5.2, §7, §8). The `grill-result` document itself is not in this repository; the section text
is taken from the comments that cite it and from `SECURITY.md`.

A change to the two-origin handoff gets a security review (`CONTRIBUTING.md:141-144`). Section 5 is
written to be read on its own.

---

## 1. Problem

A viewer who pastes an artifact origin URL directly into a browser gets a bare 404 reading
"This artifact is no longer available." — even when they are the signed-in owner and the artifact is
`public`. Reproduced against the live instance:

```
curl -i https://efd2c613-ed53-4a4b-8305-44d7a7c412fd.dat-nguyen.me/
HTTP/2 404
x-middleware-rewrite: /artifact-origin/efd2c613-…/serve
<p>This artifact is no longer available.</p>
```

Visiting `https://enclave.dat-nguyen.me/a/efd2c613-…` first and then returning to the subdomain
works, because the viewer page frames `/__enter?t=…`, which mints the `enclave_grant` cookie
(`Max-Age=1800`, `SameSite=None`, host-only) that `/serve` requires.

This is not an authorization bug. The artifact origin is correct to refuse an entry it cannot
authorize — it has no session and makes no authorization decisions of its own (`SECURITY.md:99-101`).
It is a UX gap: the refusal tells a legitimate viewer nothing and offers no way forward. Two
sub-cases hide behind the same 404.

**Sub-case A — no cookie at all.** A cold browser, a direct paste, a bookmark, a link shared
out-of-band. `request.cookies.get(GRANT_COOKIE_NAME)` is `undefined`
(`app/(artifact)/artifact-origin/[id]/serve/[[...path]]/route.ts:106-107`).

**Sub-case B — expired cookie.** The viewer had a working session and the 30-minute grant lapsed
(`ARTIFACT_GRANT_TTL_SECONDS`, default 1800, `src/env.ts`; written at
`src/lib/artifacts/grant.ts:64-71`). `verifyGrantToken` returns `null` and the same 404 is emitted
(`serve/…/route.ts:109-110`). This is the more annoying one: a long read or a reload after lunch
dead-ends mid-artifact, on an artifact that was visibly working a moment ago.

---

## 2. Current behaviour

The path a direct paste takes, end to end.

**1. The proxy classifies the origin.** `proxy()` reads the host and asks
`artifactIdFromHost(requestHost(request))` (`proxy.ts:112-117`). `artifactIdFromHost`
(`src/lib/artifacts/origin.ts:47-57`) matches the host against a regex built from
`ARTIFACT_ORIGIN_TEMPLATE` and requires the captured label to be a well-formed UUID
(`origin.ts:13`, `origin.ts:56`). Anything else is `null` and the request is an app-origin request.

**2. The proxy rewrites, and sets the artifact header set.** `handleArtifactOrigin`
(`proxy.ts:81-92`) maps:

| Incoming path on `{id}.artifacts.example.com` | Rewritten to |
|---|---|
| `/__enter` (`ARTIFACT_ENTER_PATH`, `origin.ts:23`) | `/artifact-origin/{id}/enter` |
| `/` | `/artifact-origin/{id}/serve` |
| `/deep/page.html` | `/artifact-origin/{id}/serve/deep/page.html` |

Every path is rewritten, `_next/static` included (`proxy.ts:119-123`), so there is no request shape
that reaches the internal routes without this mapping. `withArtifactHeaders` (`proxy.ts:70-75`) puts
the §4.3 artifact CSP (`proxy.ts:56-68`), `nosniff` and `cross-origin-resource-policy: same-site` on
the response. The `x-middleware-rewrite: /artifact-origin/…/serve` header in the reproduction above
is Next.js's own marker for that rewrite.

The app origin's header set is deliberately *not* applied here: `X-Frame-Options: DENY`
(`proxy.ts:26`) would block the viewer's own iframe, and the app CSP carries
`frame-ancestors 'none'` (`proxy.ts:44`).

**3. `/serve` refuses.** `GET` in `serve/[[...path]]/route.ts:101-137` runs, in order:

| Line | Check | On failure |
|---|---|---|
| 102-104 | host id re-derived and matched against the route param | `artifactNotAvailable()` |
| 106-107 | `enclave_grant` cookie present | `artifactNotAvailable()` |
| 109-110 | `verifyGrantToken(cookie, hostArtifactId)` | `artifactNotAvailable()` |
| 112-115 | `authorizeArtifactRead(grant.artifactId, grant.viewerRef)` — **first database call** | `artifactNotAvailable()` |
| 117-124 | `resolveManifestPath` against the version manifest | `artifactNotAvailable()` |
| 126-137 | stream (navigable type) or 302 to a presigned URL | `artifactStorageUnavailable()` on `STORAGE_UNAVAILABLE` |

A cold paste fails at line 107; an expired grant fails at line 110. **Both fail above line 112, so
neither has touched Postgres or object storage.** That fact is what section 5 rests on.

**4. The 404 body.** `artifactNotAvailable()` (`origin.ts:80-87`) renders
`artifactOriginPage(404, 'This artifact is no longer available.')` — a one-line HTML document with
`content-type: text/html; charset=utf-8` and `cache-control: no-store` (`origin.ts:70-78`). Its
doc comment states the §7 rule: unauthorized, revoked, replayed, wrong host and unknown path all
collapse to this one response.

**5. What the working path does instead.** `/a/{id}` (`app/a/[id]/page.tsx`) resolves the viewer
(`readArtifactPage`, `src/lib/artifacts/page-read.ts:75-103`), redirects a signed-out visitor to
`/signin` and `notFound()`s a signed-in-but-refused one (`page.tsx:55-61`), mints a handoff token
bound to `{artifactId, versionId, viewerRef}` (`page.tsx:65-69`, `src/lib/handoff.ts:43-52`), and
frames `{artifactOrigin}/__enter?t=…` (`page.tsx:123-125`) inside the sandbox at
`app/a/[id]/artifact-frame.tsx:39`. `/__enter` (`enter/route.ts:28-79`) burns the token
(`handoff.ts:65-82`), re-checks authorization, and 302s to `/` with the grant cookie attached
(`enter/route.ts:70-79`).

So the machinery that turns a bare artifact-origin URL into a working artifact already exists and is
already reachable. It is one hop away, and nothing points at it.

---

## 3. Decision

**When an artifact-origin request fails for want of a grant — and only then, and only above the
first database call — answer a top-level navigation with `302 → {APP_URL}/a/{id}` and a framed
navigation with a 404 page carrying a link to the same place. Every other failure stays exactly the
404 it is today. `proxy.ts` does not change.**

The app origin then does what it already does: session, `canRead`, fresh handoff token, framed
`/__enter`, grant cookie, artifact. One redirect, no new authorization surface, no new secret, and
sub-case A and sub-case B are fixed by the same branch.

### 3.1 Redirect, or a rendered interstitial

**Both, chosen by request context.**

A 302 is invisible and fast, and it is the right answer for a top-level navigation. It does change
the address bar to `{APP_URL}/a/{id}` — which `src/lib/artifacts/naming.ts:33-40` already names as
the correct outcome: `/a/{id}` is "the URL a reader is given, and the only one a crawler can index",
and the artifact origin "is never the canonical address of anything". The address bar ends up
showing the artifact's real address rather than its plumbing.

Inside an iframe a 302 to the app origin is useless: the app CSP sets `frame-ancestors 'none'`
(`proxy.ts:44`) and the browser blocks the load, replacing today's readable 404 with a blank frame.
So the framed case gets a small HTML page served from the artifact origin instead.

That page must survive the artifact CSP (`proxy.ts:56-68`): `default-src 'self' data: blob:`,
`form-action 'none'`, and `frame-ancestors {appOrigin}`. It therefore has **no script, no form and
no external resource of any kind** — one inline `<style>` block (permitted by
`style-src 'self' 'unsafe-inline' https:`) and one `<a>`. It cannot load the app's stylesheet or the
Geist font files, both of which live on the app origin and would be rewritten to this artifact's
manifest and 404 (`proxy.ts:119-123`), so the tokens it needs are inlined literally from `design.md`
(`--color-paper`, `--color-ink`, `--color-accent`, plus the `prefers-color-scheme: dark` values) and
the font stack degrades to `ui-sans-serif, system-ui`. Per `docs/motion.md`'s frequency table the
page **does not animate**: it is an error-recovery surface shown at load, and there is no spatial
change to explain.

One sandbox constraint is load-bearing and cannot be designed around. The viewer's iframe is
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"`
(`artifact-frame.tsx:39`) — no `allow-top-navigation` and no
`allow-top-navigation-by-user-activation`. A `target="_top"` link inside that frame is blocked.
The link therefore uses `target="_blank" rel="noopener noreferrer"`, which `allow-popups` permits,
and the viewer reopens the artifact in a new tab. Adding `allow-top-navigation` to the sandbox to
get a nicer in-place transition is **rejected**: it hands every generated artifact the ability to
navigate the top-level page away, which is a strictly worse trade than one extra tab.

Rejected: **only an interstitial, never a redirect.** It keeps the address bar, but it makes the
common case (cold paste of a link someone sent you) a page with a button on it rather than the
artifact. The redirect is the whole point.

Rejected: **a meta-refresh or a JS redirect on the artifact origin.** `script-src` there allows
`'unsafe-inline'`, so it would work — and it would mean the artifact origin emits a page whose only
job is to bounce the browser, which is a 302 with extra steps and one more thing to get wrong.

### 3.2 Which requests may redirect

`Sec-Fetch-Dest` is the signal. A top-level navigation sends `Sec-Fetch-Dest: document` (and
`Sec-Fetch-Mode: navigate`); a nested navigation sends `iframe` (or `frame`); a subresource sends
`image`, `style`, `script`, `font`, `empty` (for `fetch`/XHR) and so on.

Only `document` redirects. `iframe`/`frame` gets the interstitial. Everything else keeps the bare
404, because turning a missing stylesheet or a `fetch()` from artifact JavaScript into a 302 toward
the app origin would make a missing asset arrive as confusing HTML, and would put app-origin HTML
inside the sandbox where an artifact could read it. `Sec-Fetch-Mode` is not consulted — a `document`
destination is always a navigation, and reading one header is easier to test than reading two.

**This repository reads no `Sec-Fetch-*` header anywhere today** (verified: no match for
`sec-fetch` under `src/`, `app/` or `proxy.ts`). This is a new header dependency, and the fallback
is what makes it safe.

**Fallback when `Sec-Fetch-Dest` is absent** (old Safari before 16.4, `curl`, some bots): fall back
to the first media type in `Accept`. If it starts with `text/html`, treat the request as **framed**,
not as top-level; otherwise treat it as a subresource.

Falling back to *framed* rather than *top-level* is deliberate and is the safer of the two:

- The interstitial is functional in both contexts — top-level it renders and its link works,
  framed it renders and its link works. A 302 is functional in only one, and produces a **blank
  frame** in the other.
- Safari is exactly the browser that both lacked `Sec-Fetch-*` until 16.4 and blocks the
  `SameSite=None` third-party grant cookie by default. The framed-grant-failure case is the one an
  older Safari is most likely to hit, and it is the one where a 302 would be worst.
- A no-signal client loses the seamless redirect and gets a page with a link. That is a degradation
  from the new best case, never a regression from today's bare 404.

Accept-header discrimination is coarse but sufficient here: a navigation sends
`text/html,application/xhtml+xml,…`, a stylesheet sends `text/css,*/*;q=0.1`, an image sends
`image/…`, and `fetch()` sends `*/*`. Only the first lands on `text/html`.

### 3.3 The artifact root, or any path

**Any path may redirect; the path itself is dropped.** `{id}.host/deep/page.html` with no cookie
redirects to `{APP_URL}/a/{id}`, and the viewer lands on the artifact's entry document.

Carrying the path is **rejected for this change**, for four reasons:

1. The artifact origin cannot validate it. `resolveManifestPath` needs the version manifest, which
   needs `authorizeArtifactRead`, which is the database call this whole design stays above. Checking
   the path before redirecting would make the response depend on whether the artifact exists —
   exactly the oracle section 5 exists to prevent.
2. It would have to travel through the handoff token. `/__enter` 302s to `/` unconditionally
   (`enter/route.ts:78`). Resuming a deep path means a new claim in `HandoffClaims`
   (`handoff.ts:18-22`), a new query parameter on `/a/{id}`, and a new `Location` computation in
   `/__enter` — three changes to the exact surface §4.2 governs, for a rare case.
3. It puts an attacker-supplied path string on the app origin, which then hands it back as a
   `Location` on the artifact origin. That is an open-redirect shape, avoidable only by validating
   it against the manifest inside `/__enter` before use.
4. It leaks the deep path into the app origin's request line, referrers and logs, where today only
   the artifact id goes.

If it is wanted later, the shape is fixed and should be specified separately: a `p` query parameter
on `/a/{id}`, echoed into a new optional `path` claim on the handoff token, and validated inside
`/__enter` with `resolveManifestPath(authorized.manifest, path)` — after authorization, on the
origin that owns the manifest — before it is allowed to become the `Location`. Anything that does
not survive that check falls back to `/`.

Losing the deep path is cheap in practice: multi-page artifacts keep the artifact origin as their
base URL and stream every page from it (`serve/…/route.ts:126-131`, pinned by
`tests/unit/artifact-serve-documents.test.ts`), so a reader who lands on the entry document can
navigate to where they meant to go.

### 3.4 Information disclosure

Stated here, analysed in section 5: **the redirect fires for any well-formed UUID host, existing or
not**, because the artifact origin does not know whether the artifact exists at the point the
decision is made.

### 3.5 Loop safety

The guard is structural: **the redirect only ever points at the app origin, and nothing on the app
origin redirects to an artifact origin — `/a/{id}` *frames* it.** A cycle would need a hop back,
and there is none.

The three terminal outcomes of `/a/{id}` (`page.tsx:55-61`) are `redirect('/signin')`, `notFound()`,
and a rendered page. None is a redirect to an artifact origin.

The second guard is 3.2: the framed case never 302s. That matters most when `/__enter` succeeds but
the browser refuses to store the `SameSite=None` cookie (Safari ITP, or a user blocking third-party
cookies). The frame then loads `/`, finds no cookie, and — because it is `Sec-Fetch-Dest: iframe` —
gets the interstitial, not a redirect back to the page that framed it.

`/__enter` replay is normal on a reload and must not loop. It does not: a replayed token top-level
redirects once to `/a/{id}`, which mints a *fresh* token (`page.tsx:65-69`) and frames it, and the
fresh token is not in `consumedTokenIds` (`handoff.ts:33`). A replayed token inside the frame gets
the interstitial and stops.

The third guard is which failures qualify at all — see the tables in section 4. Any failure at or
below the first database call in either route stays a 404, forever.

### 3.6 Cookie expiry mid-session

**The redirect alone. No sliding renewal.** Rejected, with reasons:

Renewing the grant on activity would not weaken §4.2 step 5. Step 5 re-runs `authorizeArtifactRead`
against Postgres on *every* request (`serve/…/route.ts:112`, `authorize.ts:196-218`), so the cookie's
TTL is not what enforces revocation — revocation is already immediate for the document
(`SECURITY.md:124-127`). A longer-lived or renewed cookie changes nothing about who may read.

It is rejected because it does not solve sub-case B and costs something:

- Only *document* requests pass through the app; every other type 302s to a presigned URL
  (`serve/…/route.ts:129-131`). A reader sitting in one long document issues no further document
  request, so a `Set-Cookie` on document responses would never fire for the case that motivates it.
- Every renewal mints a new `grantId` (`grant.ts:56`), churning the one value a future revocation
  list could key on.
- It adds a `Set-Cookie` to a streamed response body path, where today there is none.

An operator who wants longer sessions raises `ARTIFACT_GRANT_TTL_SECONDS`. That is already
configurable and already safe, precisely because step 5 does the real work.

### 3.7 Known limitation: share-link readers

A `/s/{token}` reader whose grant expires and who then hits the artifact origin directly is
redirected to `/a/{id}`, where they have no session and will be refused for anything not `public`.

This is not fixable at the artifact origin and should not be attempted. The capability is the share
*token*, which is stored only as a SHA-256 hash and is never returned again (`SECURITY.md:144`); the
artifact origin never sees it. The grant cookie carries only `share:{shareLinkId}`
(`authorize.ts:52-55`), and on an expired or absent cookie there is nothing to read anyway — reading
an unverified or expired token to recover a viewer identity is exactly what §4.2 forbids.

The share-link reader keeps the link they were sent, and it still works. Nothing gets worse.

---

## 4. Changes, per file

### CHG-1 — `src/lib/artifacts/origin.ts`

This module is imported by `proxy.ts` and must stay free of database and storage imports
(`origin.ts:7`). Everything below is pure apart from `env`.

It may import `artifactPageUrl` from `./naming` (`naming.ts:38-40`), which imports only `@/env` — no
cycle, and it keeps one definition of the canonical viewer URL.

**New exports:**

```ts
/** How the browser asked for this artifact-origin URL. */
export type ArtifactEntryIntent = 'top-level' | 'framed' | 'subresource'

/**
 * Classifies from `Sec-Fetch-Dest`, falling back to `Accept` when the header is absent.
 * The fallback resolves to 'framed', never 'top-level': the re-entry page works in both
 * contexts, a redirect would be a blank frame in one of them.
 */
export function artifactEntryIntent(headers: Headers): ArtifactEntryIntent

/**
 * The single response for "this origin cannot authorize you, and does not know why".
 * `artifactId` comes from the request host and is therefore already a validated UUID.
 * Callable only above the first database call in a route — see the invariant below.
 */
export function artifactEntryUnavailable(artifactId: string, headers: Headers): Response
```

`artifactEntryIntent` branch table — every row is a unit test in CHG-5:

| `Sec-Fetch-Dest` | `Accept` | Result |
|---|---|---|
| `document` | — | `top-level` |
| `iframe` | — | `framed` |
| `frame` | — | `framed` |
| any other value (`image`, `style`, `script`, `font`, `empty`, `object`, …) | — | `subresource` |
| absent | first type starts with `text/html` | `framed` |
| absent | anything else, or `Accept` absent | `subresource` |

`artifactEntryUnavailable` dispatch:

| Intent | Response |
|---|---|
| `top-level` | `302`, `location: artifactPageUrl(artifactId)`, `cache-control: no-store`, `vary: cookie, sec-fetch-dest, accept` |
| `framed` | `404`, the re-entry HTML page (below), `cache-control: no-store`, `vary: cookie, sec-fetch-dest, accept` |
| `subresource` | `artifactNotAvailable()` — byte-for-byte what ships today |

`cache-control: no-store` on the 302 is not optional. A browser or intermediary that heuristically
caches a redirect for `/` on an artifact origin would keep bouncing the viewer to `/a/{id}` after the
grant cookie exists, which is the one way this design could break a working artifact. `vary` is belt
and braces on top of it.

The re-entry page is a private helper built on the existing `artifactOriginPage` shape
(`origin.ts:70-78`), at **status 404** — the same status as every other framed and subresource
failure, so nothing new is learnable from a status line. Its body: one heading, one sentence, and
`<a href="{artifactPageUrl(id)}" target="_blank" rel="noopener noreferrer">Open this artifact</a>`.
No script, no form, no external resource (§3.1). Suggested copy, matching the voice of the existing
pages:

> **This artifact needs to be reopened**
> Artifacts are served from their own address and need a fresh entry from enclave.
> [Open this artifact]

`artifactNotAvailable()` and `artifactStorageUnavailable()` are unchanged and keep every existing
caller.

**Invariant, to be written as a comment on `artifactEntryUnavailable`:**

> This helper must only ever be called before the route's first database call. It answers
> identically for an artifact that exists and one that never did, and that property holds only
> because nothing above the call site has consulted Postgres or object storage. Adding any lookup
> above a call site turns this into an existence oracle (§7).

### CHG-2 — `app/(artifact)/artifact-origin/[id]/serve/[[...path]]/route.ts`

Two `return artifactNotAvailable()` calls become `return artifactEntryUnavailable(...)`. Nothing
else in the file changes; no import is removed.

| Line today | Condition | Before | After |
|---|---|---|---|
| 104 | host id null or ≠ route param | 404 | **404, unchanged** — a proxy invariant breach, and there may be no id to redirect to |
| 107 | `enclave_grant` absent | 404 | `artifactEntryUnavailable(hostArtifactId, request.headers)` — **sub-case A** |
| 110 | `verifyGrantToken` returns null (expired, forged, or minted for another artifact) | 404 | `artifactEntryUnavailable(hostArtifactId, request.headers)` — **sub-case B** |
| 113-115 | `authorizeArtifactRead` null or version mismatch | 404 | **404, unchanged** — first database call; see section 5 |
| 124 | path absent from the manifest | 404 | **404, unchanged** — database-informed, and a missing deep path is not an entry problem |
| 133-135 | storage unavailable | 503 | unchanged |

### CHG-3 — `app/(artifact)/artifact-origin/[id]/enter/route.ts`

Same shape.

| Line today | Condition | Before | After |
|---|---|---|---|
| 31 | host id null or ≠ route param | 404 | **404, unchanged** |
| 34 | `t` query parameter absent | 404 | `artifactEntryUnavailable(hostArtifactId, request.headers)` |
| 38 | `consumeHandoffToken` null (bad signature, wrong audience, expired, malformed, **already used**) or artifact mismatch | 404 | `artifactEntryUnavailable(hostArtifactId, request.headers)` — the replay case |
| 42-44 | `authorizeArtifactRead` null or version mismatch | 404 | **404, unchanged** — first database call, and this viewer was genuinely refused |
| 70-79 | success | 302 to `/` with the grant cookie | unchanged |

`consumeHandoffToken` burns the token before this branch is reached (`handoff.ts:77`), and it stays
that way — the redirect must not become a reason to stop burning. Its rejections remain
indistinguishable from one another (`handoff.ts:61-64`); this change does not let a caller branch on
the reason either, since all of them take the same new path.

Note that in practice `/__enter` is almost always `Sec-Fetch-Dest: iframe`, so the top-level branch
here serves the bookmark-an-`__enter`-URL case and little else. It is still worth having: today that
URL is a permanent dead end.

### CHG-4 — `proxy.ts`

**No change.** Stated explicitly because the reviewer will look:

- The rewrite already maps every artifact-origin path onto the two routes (`proxy.ts:81-92`), so the
  new branches are reachable without touching it.
- `withArtifactHeaders` (`proxy.ts:70-75`) already decorates whatever the route returns, so the 302
  and the re-entry page get the artifact CSP, `nosniff` and CORP for free.
- Emitting the redirect from the proxy instead would mean parsing cookies and verifying a JWT in the
  proxy, on every request to every artifact path, `_next/static` included — strictly more work in
  strictly the hottest place, for the same answer.
- Both header sets (`proxy.ts:25-30`, `proxy.ts:34-49`, `proxy.ts:56-68`) are untouched.

### CHG-5 — `tests/unit/artifact-origin.test.ts`

Extend. See section 6.

### CHG-6 — `tests/unit/artifact-direct-entry.test.ts` (new)

Route-level branch coverage for CHG-2 and CHG-3. See section 6.

### CHG-7 — `tests/integration/privacy-gate.test.ts`

Extend with the refused-viewer case. See section 6.

### CHG-8 — `tests/e2e/viewer-sandbox.spec.ts` and `tests/e2e/zz-direct-artifact-entry.spec.ts` (new)

Four existing assertions change value. See section 6 and section 7 — this is the part most likely to
surprise a reviewer.

### CHG-9 — `SECURITY.md`

Two statements become untrue as written and must be amended in the same commit:

- Line 110: "Replaying the same token afterwards is a 404." → a replay is still refused and the
  token is still burnt; a *top-level* replay is answered with a redirect to `/a/{id}`, which
  re-authorizes from scratch.
- Lines 116-118: "Every failure on the artifact origin … returns the same `404` with the same body."
  → still true for every failure at or below the authorization check. A request that arrives with no
  usable grant at all is answered with a redirect (top-level) or a re-entry page (framed), for **any**
  well-formed artifact host, whether or not the artifact exists — so it still distinguishes nothing.

Add a sentence naming the invariant from CHG-1 explicitly, since it is the property the amended
paragraph now depends on.

---

## 5. Security review

Written to stand alone. The change: an artifact-origin request that arrives with no usable grant
cookie is answered with `302 → {APP_URL}/a/{id}` (top-level navigation) or a 404 page containing a
link to the same URL (framed), instead of a bare 404. Nothing else about the origin model changes.

### 5.1 The existence oracle (§7) — the hard constraint

§7 makes every artifact-origin failure identical so that "exists but you may not read it" is
indistinguishable from "never existed". A redirect that fired for real artifact ids but not for
bogus ones would be an existence oracle for an unauthenticated scanner who can guess UUIDs.

**It does not fire selectively, because the artifact origin does not know.** Verified against the
code:

- `/serve` reaches the no-cookie branch (line 107) after exactly three operations: `artifactIdFromHost`
  (a regex over the `Host` header, `origin.ts:47-57`), `await context.params`, and
  `request.cookies.get`. None is I/O.
- It reaches the invalid-grant branch (line 110) after one more: `verifyGrantToken`
  (`grant.ts:85-101`), which is HMAC verification against `SESSION_SECRET` plus a string comparison
  against the host-derived id. No I/O.
- The first database call is `authorizeArtifactRead` at line 112, strictly below both.
- `/__enter` is the same shape: the token branches (lines 34, 38) sit above `authorizeArtifactRead`
  at line 41. `consumeHandoffToken` (`handoff.ts:65-82`) verifies a JWT and consults an in-process
  `Map` (`handoff.ts:33`) — no database.

**Invariant (must be a comment in the source, per CHG-1, and asserted by a test, per CHG-6):**

> The artifact origin redirects for any host matching `artifactOriginPattern()` with a well-formed
> UUID label, whether or not that artifact exists, because at that point in the request it has not
> asked. Adding any database or storage lookup above `artifactEntryUnavailable` — an existence
> pre-check, a "was this ever an artifact" cache, a metrics counter keyed on a row — converts this
> into an existence oracle and must not be done.

The scanner's view before and after:

| Request | Today | After |
|---|---|---|
| `GET /` on a real artifact's host, no cookie, navigation | 404 | 302 → `/a/{real-id}` |
| `GET /` on a random UUID host, no cookie, navigation | 404 | 302 → `/a/{random-id}` |
| `GET /` on a real artifact's host, no cookie, `fetch()` | 404 | 404 |
| `GET /` on a random UUID host, no cookie, `fetch()` | 404 | 404 |
| Host with a non-UUID label | 404 (`artifactIdFromHost` → null → app origin → 404 for the `/artifact-origin` prefix, `proxy.ts:95-97`) | unchanged |

The two rows in each pair are identical, which is the property that matters. Following the redirect
gains the scanner nothing either: `/a/{id}` redirects a signed-out visitor to `/signin` and gives a
signed-in-but-refused viewer `notFound()` (`page.tsx:55-61`), which is the app origin's own uniform
refusal, already covered by the "Existence leaks" row of `SECURITY.md:147`.

One response shape does become distinguishable, and it is worth naming precisely: a request with **no
cookie** now differs from a request with a **valid cookie that authorization refuses** (302/re-entry
page vs. bare 404). That difference is visible only to someone who already holds a valid grant cookie
for that exact host — i.e. someone the app already authorized for that exact artifact — and it tells
them only that their own authorization has been withdrawn, which the missing content already told
them. It reveals nothing about any other artifact and nothing about existence.

### 5.2 Open redirect

The `Location` is `artifactPageUrl(artifactId)` =
`new URL('/a/' + artifactId, env.APP_URL).toString()` (`naming.ts:38-40`).

- The base is `env.APP_URL`, validated as a URL by the environment schema (`src/env.ts`) at startup
  and not request-controlled.
- The path is `/a/` plus `artifactId`, which comes from `artifactIdFromHost` and has passed
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` (`origin.ts:13`, `origin.ts:56`).
  Thirty-six characters from a sixteen-character alphabet: no scheme, no `//`, no `@`, no `\`, no
  `.` outside the pattern, nothing to escape a path segment with.
- No part of the request URL — path, query, fragment — reaches the `Location`. §3.3 is what keeps it
  that way, and is the main reason the deep path is dropped rather than carried.
- The request `Host` influences the target only by selecting one of the UUIDs the pattern admits,
  and only onto the app's own origin.

There is no input from which an open redirect could be constructed. If §3.3's follow-up is ever
built, this analysis has to be redone: a viewer-supplied path would then reach a `Location`, and the
manifest check inside `/__enter` becomes load-bearing.

### 5.3 Sandbox isolation

Unchanged, and specifically:

- The sandbox attribute is untouched (`artifact-frame.tsx:39`). `allow-same-origin` remains safe for
  the reason `SECURITY.md:48-70` gives: the frame's origin belongs to exactly one artifact and holds
  only that artifact's grant cookie. This change does not put more than one artifact on a hostname.
- **No app-origin HTML enters the sandbox.** The framed branch returns a page served *from the
  artifact origin*, and the top-level branch — the only one that points a browser at the app origin —
  is unreachable from inside a frame by construction (`Sec-Fetch-Dest: iframe`, and the
  no-signal fallback is `framed`, §3.2). Even if a browser misreported and a 302 were emitted inside
  the frame, `frame-ancestors 'none'` (`proxy.ts:44`) blocks the load: the failure mode is a blank
  frame, never app markup readable by artifact script.
- Artifact JavaScript calling `fetch('/whatever')` after its grant expires gets
  `Sec-Fetch-Dest: empty` → the bare 404, byte-identical to today. It cannot obtain app HTML by
  asking its own origin for it.
- The re-entry page runs no script of its own, so it adds no code to an origin whose CSP allows
  `'unsafe-inline'`.
- `rel="noopener noreferrer"` on the link keeps the opened tab from reaching back through
  `window.opener` and keeps the artifact-origin URL out of the app's `Referer`.

### 5.4 Log hygiene (§8)

Nothing new is logged. The two routes log nothing today and this change adds no logging call.
Specifically:

- The `Location` contains only `{APP_URL}/a/{artifactId}`. The artifact id is already a public
  hostname component; no token, no cookie, no presigned URL.
- The handoff token stays in the query string it already occupies. `/__enter`'s new branch is
  reached *after* `consumeHandoffToken` and never echoes `t` anywhere — in particular the redirect
  target must not carry it forward, and does not.
- The grant cookie is never read into a message, and the re-entry page's body contains no
  request-derived string other than the artifact id.
- A reverse proxy's access log will now record a 302 where it recorded a 404, with the same URL. The
  `Location` header may be logged by some proxies; it contains nothing sensitive.

### 5.5 What an attacker gains

Nothing that survives inspection:

- **Confirming an artifact exists:** no — §5.1.
- **Reading an artifact they may not read:** no. `canRead` (`can-read.ts:69-111`) is untouched, and
  every path to bytes still runs `authorizeArtifactRead` on every request
  (`serve/…/route.ts:112`). The redirect hands the viewer to the app origin's gate; it does not
  bypass one.
- **Replaying a burnt handoff token:** no. It is still burnt (`handoff.ts:65-82`) and still refused;
  the viewer is merely told where to get a new one, which is a page anyone may visit.
- **Using a stolen grant cookie on another artifact's host:** no. `verifyGrantToken` still rejects it
  (`grant.ts:85-101`, payload `artifactId` vs. request host). The response changes from a 404 to a
  redirect to `/a/{stolen-host-id}`, where the app applies its own gate to whoever the attacker
  actually is. This is a **visible change to an existing security test** — see section 7.
- **Phishing via the redirect:** no. The target is fixed to `env.APP_URL` (§5.2).
- **Amplification or a redirect loop:** no. §3.5 — the redirect crosses origins in one direction and
  the app origin never redirects back.

### 5.6 What must NOT change

Enumerated so a reviewer can check each one against the diff:

1. **Every app-origin authorization decision.** `app/a/[id]/page.tsx`, `app/s/[token]/page.tsx`,
   `src/lib/artifacts/page-read.ts` — untouched.
2. **`canRead`** (`src/lib/artifacts/can-read.ts`) — untouched, and its 100% branch coverage
   (`CONTRIBUTING.md:61-72`) stays where it is.
3. **`authorizeArtifactRead`** (`authorize.ts:196-218`) and its re-run on every artifact-origin
   request (§4.2 step 5) — untouched, and still strictly *below* every new branch.
4. **The handoff token**: single-use (`handoff.ts:33`, `handoff.ts:75-77`), `HANDOFF_TTL_SECONDS`,
   the `{artifactId, versionId, viewerRef}` claims, and the rule that no caller can branch on the
   rejection reason (`handoff.ts:61-64`) — untouched.
5. **The grant cookie**: host-only (no `Domain`), `HttpOnly`, `Secure`, `SameSite=None` and its
   rationale, `Max-Age`, and the `artifactId` payload check against the request host
   (`grant.ts:40-72`, `grant.ts:85-101`) — untouched.
6. **Both CSP header sets and the app's `X-Frame-Options: DENY`** (`proxy.ts:25-68`) — untouched, and
   `proxy.ts` does not change at all (CHG-4).
7. **The uniform failure for anything genuinely unauthorized**: a refused authorization, a
   manifest miss, a host mismatch and a storage failure all keep the exact response they have today
   (CHG-2, CHG-3).
8. **The iframe sandbox attribute** (`artifact-frame.tsx:39`) — untouched; §3.1 explicitly rejects
   widening it.

---

## 6. Test plan

Per `CONTRIBUTING.md:74-89`: one scenario per test, the failing test first, specific values
asserted, never truthiness — and the unauthorized case is not optional. `CONTRIBUTING.md:78-79`
prescribes `<action>_<condition>_<expected result>` names; the existing suite uses prose titles
throughout, and the titles below match the files they are added to.

### CHG-5 — `tests/unit/artifact-origin.test.ts`

New `describe('artifactEntryIntent')`, one test per row of the CHG-1 branch table — every branch,
since this helper decides whether app-origin HTML can be pointed at:

- `classifies Sec-Fetch-Dest: document as a top-level navigation` — `toBe('top-level')`
- `classifies Sec-Fetch-Dest: iframe as framed` — `toBe('framed')`
- `classifies the legacy frame destination as framed` — `toBe('framed')`
- `classifies every subresource destination as a subresource` — `it.each` over
  `['image', 'style', 'script', 'font', 'empty', 'object', 'audio', 'video']`, each `toBe('subresource')`
- `falls back to framed, not top-level, for an HTML Accept with no Sec-Fetch-Dest` —
  `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` → `toBe('framed')`
- `falls back to a subresource for a stylesheet Accept with no Sec-Fetch-Dest` —
  `Accept: text/css,*/*;q=0.1` → `toBe('subresource')`
- `falls back to a subresource for the wildcard Accept a fetch() sends` — `Accept: */*` →
  `toBe('subresource')`
- `falls back to a subresource when neither header is present` — `toBe('subresource')`

New `describe('artifactEntryUnavailable')`:

- `redirects a top-level navigation to the app-origin viewer page` — `status` `toBe(302)`,
  `headers.get('location')` `toBe('http://localhost:3000/a/{ARTIFACT_ID}')`
- `sends no-store on the redirect, so a cached bounce cannot outlive the grant` —
  `headers.get('cache-control')` `toBe('no-store')`
- `varies on cookie and Sec-Fetch-Dest` — `headers.get('vary')` `toBe('cookie, sec-fetch-dest, accept')`
- `answers a framed request with a 404 page that links to the viewer` — `status` `toBe(404)`, body
  `toContain('http://localhost:3000/a/{ARTIFACT_ID}')` and `toContain('target="_blank"')`
- `answers a subresource with the unchanged failure page` — `status` `toBe(404)`, body
  `toBe(await artifactNotAvailable().text())`
- `puts no script and no form in the re-entry page, which the artifact CSP would refuse` — body
  `not.toContain('<script')` and `not.toContain('<form')`
- `never names the artifact anywhere but in the viewer link` — body `not.toContain('artifact-origin')`

The existing `artifact-origin failure pages` describe block is unchanged; `artifactNotAvailable()`
keeps its current assertions.

### CHG-6 — `tests/unit/artifact-direct-entry.test.ts` (new)

Route-level. Mocks follow `tests/unit/artifact-serve-documents.test.ts:35-64` — `@/lib/storage/s3`,
`@/lib/artifacts/grant` and `@/lib/artifacts/authorize`, so `authorizeArtifactRead` is a spy.

`describe('/serve without a usable grant')`:

- `redirects a top-level navigation with no grant cookie to the viewer page` — no `cookie` header,
  `sec-fetch-dest: document`; `status` `toBe(302)`, `location`
  `toBe('http://localhost:3000/a/{ARTIFACT_ID}')`
- `redirects a top-level navigation whose grant cookie has expired` — `verifyGrantToken` mocked to
  `null`; same two assertions
- `answers the framed entry with a 404 re-entry page rather than a redirect` —
  `sec-fetch-dest: iframe`; `status` `toBe(404)`, `location` `toBeNull()`, body
  `toContain('/a/{ARTIFACT_ID}')`
- `keeps a stylesheet subresource on the unchanged 404` — `sec-fetch-dest: style`; `status`
  `toBe(404)`, `location` `toBeNull()`, body `not.toContain('/a/')`
- `keeps a fetch() from artifact JavaScript on the unchanged 404` — `sec-fetch-dest: empty`; same
- `redirects a deep path to the artifact root, carrying no path` — request
  `/deep/page.html`, `sec-fetch-dest: document`; `location`
  `toBe('http://localhost:3000/a/{ARTIFACT_ID}')` — asserting the *absence* of the path in the target
- **`asks the database nothing before redirecting`** — the §7 invariant, asserted mechanically:
  `expect(authorizeArtifactRead).not.toHaveBeenCalled()` and
  `expect(getObjectStream).not.toHaveBeenCalled()` on the no-cookie top-level request. This is the
  test that fails if someone later adds an existence pre-check.

`describe('/serve loop guard')`:

- `keeps a refused authorization on the 404, so a redirect cannot bounce a refused viewer` —
  valid cookie, `authorizeArtifactRead` mocked to `null`, `sec-fetch-dest: document`; `status`
  `toBe(404)`, `location` `toBeNull()`
- `keeps a version mismatch on the 404` — `authorizeArtifactRead` returns a different `versionId`;
  same assertions
- `keeps a manifest miss on the 404 even for a top-level navigation` — valid cookie,
  `/secrets.html`, `sec-fetch-dest: document`; `status` `toBe(404)`, `location` `toBeNull()`
- `keeps a host that does not match the route param on the 404` — `status` `toBe(404)`,
  `location` `toBeNull()`

`describe('/__enter without a usable token')`:

- `redirects a top-level entry with no token to the viewer page` — `status` `toBe(302)`, `location`
  `toBe('http://localhost:3000/a/{ARTIFACT_ID}')`
- `redirects a replayed token top-level instead of dead-ending` — `consumeHandoffToken` mocked to
  `null`; same assertions
- `answers a replayed token inside the frame with the re-entry page, not a redirect` —
  `sec-fetch-dest: iframe`; `status` `toBe(404)`, `location` `toBeNull()`
- `still burns the token before deciding` — `expect(consumeHandoffToken).toHaveBeenCalledTimes(1)`
- `keeps a refused authorization on the 404 after a valid token` — `consumeHandoffToken` returns
  claims, `authorizeArtifactRead` returns `null`, `sec-fetch-dest: document`; `status` `toBe(404)`,
  `location` `toBeNull()`
- `sets no grant cookie on any of these responses` — `headers.get('set-cookie')` `toBeNull()`

### CHG-7 — `tests/integration/privacy-gate.test.ts`

Added to the existing `S4 privacy gate and audit log` describe, reusing its Alice/Bob fixtures. Real
Postgres; the point is that the redirect changes nothing about who may read.

- `gives a signed-in but refused viewer nothing but the app origin's own refusal` — with the
  artifact `private` and Bob signed in: `await authorizeArtifactRead(artifactId, userViewerRef(bobId))`
  `toBeNull()`, and `/serve` for Bob with a valid grant minted for Alice is `toBe(404)` with
  `location` `toBeNull()`
- `redirects Bob's cookieless top-level request and still refuses him at the gate` — `/serve` with
  no cookie and `sec-fetch-dest: document` is `toBe(302)`; `authorizeArtifactRead` for Bob is still
  `toBeNull()`, so the redirect leads to a refusal and not to bytes
- `redirects identically for an artifact id that does not exist` — the §7 pair, against the real
  database: `/serve` on a random UUID host with no cookie returns the *same* `status` (302) and the
  same `location` shape as the real artifact's host. `authorizeArtifactRead` on that id is
  `toBeNull()`, proving the row genuinely is not there.
- `writes no artifact.view row for a request that only redirects` — count `artifact.view` rows
  before and after; `toHaveLength(before.length)`. The audit row belongs to `/__enter`'s success
  path (`enter/route.ts:56-66`) and must not follow a redirect.

### CHG-8 — e2e

**`tests/e2e/viewer-sandbox.spec.ts` — four existing assertions change value.** All four are
top-level `page.goto` calls, so all four now meet the redirect. Each keeps its security meaning by
asserting the *destination* rather than just the status:

| Test | Today | After |
|---|---|---|
| `a replayed handoff token is a 404` (line 340) | `status()` `toBe(404)` | `toBe(302)`, and the landing page is `/signin` or the app 404 — never artifact content. Rename: `a replayed handoff token is sent back to the viewer page, not into the artifact` |
| `/__enter without a token is a 404` (line 357) | `toBe(404)` | `toBe(302)` with `location` `toBe('{APP_ORIGIN}/a/{artifactA}')` |
| `an unauthenticated request to an artifact origin is a 404 (US-3·AC3)` (line 368) | `toBe(404)` | `toBe(302)`; then assert the anonymous context lands on `/signin` and that `#marker` never appears — AC3 is "cannot read it", and that is what should be asserted |
| `artifact A's grant cookie presented on artifact B's host is a 404` (line 381) | `toBe(404)` | `toBe(302)`; add `expect(await grantCookieValue(attacker, artifactB))` to show no grant was minted, and assert the attacker's page shows no artifact content. **This is a security test — reviewers should read this diff first.** |

Unchanged and re-run as regressions: `a path absent from the version manifest is a 404` (valid
cookie, manifest miss), `the internal rewrite target is not reachable on the app origin`, both
CSP-header tests, both cross-artifact `localStorage` tests, and the presigned-asset test.

**`tests/e2e/zz-direct-artifact-entry.spec.ts` (new).** The `zz-` prefix is required, not cosmetic:
the suite orders by filename and `setup-and-signin.spec.ts` must run first — see the header comment
at `tests/e2e/viewer-sandbox.spec.ts:5-8` — and `zz-dashboard-pagination.spec.ts` is the existing
precedent.

- `a cold paste of an artifact origin lands on the rendered artifact` — the headline journey: a
  fresh signed-in `BrowserContext` with no grant cookie, `page.goto(artifactOrigin(id))`, then
  `expect(page.url()).toBe('{APP_ORIGIN}/a/{id}')` and
  `expect(frameLocator('iframe[title="Artifact"]').locator('#marker')).toHaveText('artifact A')`.
  Along the way assert the framed `__enter` ran, by
  `expect(await grantCookieValue(context, id)).not.toBe('')`.
- `an expired grant on a reload lands on the artifact again rather than a dead end` — open the
  viewer, `context.clearCookies({ domain: '{id}.artifacts.localhost' })` to simulate the lapse,
  `page.goto(artifactOrigin(id))`, assert the same two values as above
- `a cold paste of a deep path lands on the artifact's entry document` — `goto(origin + '/second-page.html')`,
  `expect(page.url()).toBe('{APP_ORIGIN}/a/{id}')` and the entry `#marker` renders
- `a signed-out visitor pasting a private artifact origin is sent to sign in` —
  `expect(page.url()).toBe('{APP_ORIGIN}/signin')`, and `#marker` never appears
- `an artifact origin for an id that does not exist redirects identically` — a random UUID host;
  `expect(page.url()).toBe('{APP_ORIGIN}/a/{randomId}')`, then the app's own 404 or `/signin`. The
  §7 pair, from a real browser.
- `the framed entry shows a re-entry link instead of a blank frame when the grant cookie is refused` —
  a context with cookies blocked for the artifact origin; assert the frame's document contains the
  `/a/{id}` link and that the top-level URL did not change

### Coverage

`origin.ts` is not one of the three modules held to 100% branches (`CONTRIBUTING.md:61-72`), but
`artifactEntryIntent` decides whether app-origin HTML may be pointed at, so CHG-5 covers **every**
branch of the table regardless. `can-read.ts` is untouched and its 100% is unaffected. Run
`pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build && pnpm test:e2e`
(`CONTRIBUTING.md:39-45`) before the merge request.

---

## 7. Rollout and risk

No migration, no environment variable, no feature flag. A flag was considered and rejected: it would
add a variable to the Zod schema (`src/env.ts`), to `.env.example` and to `docs/self-hosting.md` for
a change whose revert is three lines.

**Revert:** revert CHG-2 and CHG-3 — six call sites in two files, back to `artifactNotAvailable()`.
CHG-1 is then inert (an unused pure helper) and can stay or go. Nothing persists: no row is written,
no cookie shape changes, no token claim changes, so a revert needs no clean-up and no version skew
handling between replicas.

**What breaks if this ships wrong:**

| Failure | Symptom | Guard |
|---|---|---|
| A subresource is misclassified as a navigation | An `<img>` or `fetch()` receives app HTML or a cross-origin redirect; artifacts render broken after their grant lapses | Strict `Sec-Fetch-Dest === 'document'`, `Accept` fallback that resolves to `framed`, four subresource tests in CHG-6 |
| A framed request 302s | Blank iframe on the viewer page — worse than today's readable 404 | The framed branch never redirects; the no-signal fallback is `framed`, not `top-level` (§3.2) |
| The 302 gets cached | The artifact bounces to `/a/{id}` forever, even with a valid grant | `cache-control: no-store` and `vary` on the redirect (CHG-1), asserted in CHG-5 |
| A database call is added above the branch | Silent existence oracle for UUID-guessing scanners | The source comment invariant (CHG-1), the `not.toHaveBeenCalled()` assertion in CHG-6, and the identical-response pair in CHG-7 and CHG-8 |
| A redirect loop | Browser gives up with `ERR_TOO_MANY_REDIRECTS` | Structural: the app origin never redirects to an artifact origin (§3.5); framed never redirects |
| Someone reads the changed e2e assertions as a weakened gate | A security review stalls, or worse, is waved through | CHG-8's table, CHG-9's `SECURITY.md` amendment, and §5.5 |

**The riskiest part of this change is not the code — it is the four e2e assertions in CHG-8 that
flip from 404 to 302.** Three of them (`replayed token`, `unauthenticated request`, `stolen grant
cookie on another host`) are the tests that document the isolation model. Each must be rewritten to
assert what it always meant — the viewer does not get the artifact — rather than the status code
that used to imply it. A reviewer who sees only `404 → 302` in that diff should read §5.5.

Blast radius if it is simply wrong and nobody notices: a viewer who would have seen a 404 sees a
redirect to a page that refuses them. Nothing becomes readable that was not readable before, because
CHG-2 and CHG-3 sit strictly above every authorization call in both routes.

---

## 8. Open questions

Things this spec could not settle from the repository. Answers should land here rather than being
guessed at during implementation.

1. **`Sec-Fetch-Dest` for the initial iframe load.** This design assumes a browser sends `iframe`
   (not `document`) for the frame's own top navigation and for link clicks inside it. That is the
   specified behaviour, but nothing in this repository exercises it and it has not been measured
   against the browsers CI runs. The `framed` fallback means a wrong assumption degrades to the
   re-entry page rather than to a blank frame, but the framed e2e test in CHG-8 should be treated as
   the real verification and written first.

2. **How often the framed grant cookie is actually refused.** The `SameSite=None` rationale at
   `grant.ts:40-54` names Chrome's `blockedReasons: ["SameSiteLax"]` and nothing about Safari's ITP
   or Chrome's third-party cookie changes. If the framed `/__enter` is commonly blocked in this
   deployment, the re-entry page is not a rare fallback but the main viewer path for those users,
   and it deserves more design attention than this spec gives it. That is a measurement, not a code
   question.

3. **Whether `ARTIFACT_GRANT_TTL_SECONDS` should stay at 1800.** §3.6 argues renewal is the wrong
   fix and that raising the default is safe because §4.2 step 5 re-authorizes on every request. What
   the value *should* be is a product call about how long a reader may sit in a document, not
   something the code implies.

4. **Whether the deep path is worth carrying later.** §3.3 defers it and specifies its shape. Whether
   anyone actually deep-links into page 3 of an artifact is unknown — v1 has never run in production
   (`SECURITY.md:172-174`), so there is no traffic to look at.

5. **`x-middleware-rewrite` on artifact-origin responses.** The live reproduction in §1 shows
   `x-middleware-rewrite: /artifact-origin/efd2c613-…/serve` on a 404. That is Next.js's own header,
   it predates this change, and it discloses the internal route shape (not the artifact's existence —
   it is emitted for every artifact host). Whether it should be stripped in `withArtifactHeaders` is
   a separate question; it is noted here because a security reviewer reading §1 will see it and ask.

6. **The `grill-result` document is not in this repository.** Section numbers are cited as the source
   comments cite them. If §7's wording is stricter than "every failure looks the same to a client
   that cannot already read the artifact", §5.1's analysis needs re-reading against the actual text
   before this ships.
