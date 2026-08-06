# Security

## Reporting a vulnerability

Report privately, through GitHub's private vulnerability reporting:

**<https://github.com/datj9/enclave/security/advisories/new>**

Do not open a public issue, and do not include a working exploit in anything public. If private
reporting is unavailable on the repository, contact the maintainer through the address on their
GitHub profile (<https://github.com/datj9>) and say only that you have a security report — details
after a private channel is established.

Please include: what you did, what happened, what you expected, and the version or commit you tested.
A proof of concept helps; a paragraph of prose about what is theoretically possible usually does not.

What to expect: this is a single-maintainer project with no support contract. You should get an
acknowledgement within a week. There is no bug bounty and no reward beyond credit in the advisory,
which you can decline. Once a fix is out, the advisory is published — please hold public disclosure
until then.

### Supported versions

v1 only. There are no earlier releases, and no backports.

## The artifact isolation model

This is the part of enclave worth attacking, so here is exactly how it works and where its limits
are. Artifacts are HTML, CSS and JavaScript written by a language model from a user's prompt. They
are **untrusted code that runs in your users' browsers**, and the entire design follows from that.

### One browser origin per artifact

Every artifact is served from its own hostname:

```
{artifactId}.artifacts.example.com
```

The `artifactId` is a UUID, and a host that merely looks like an artifact origin without a
well-formed UUID in that position is not treated as one. The app itself lives on a different
hostname, and nothing on the app origin is reachable from an artifact origin.

This is not cosmetic. Because each artifact has its own origin, the browser gives every artifact its
own `localStorage`, `IndexedDB`, cookie jar and same-origin scope. Artifact A cannot read artifact
B's stored data, because to the browser they are unrelated sites.

### The sandbox, and why `allow-same-origin` is here

Artifacts render in an iframe on the app's viewer page:

```
sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
```

`allow-same-origin` looks alarming in a sandbox attribute, and usually is. Without it, the browser
puts the frame in an opaque origin, where `localStorage` and `IndexedDB` throw on access — a large
share of generated artifacts store something, so they would simply break.

It is safe here for one specific reason: **the origin the frame is allowed to be same-origin with is
a hostname belonging to exactly one artifact, and that origin holds nothing worth stealing.** The
only cookie on it is a grant cookie scoped to that single artifact, whose payload is checked against
the requested host on every read, so it is useless anywhere else. There is no session, no API access
and no other artifact's data at that origin.

The dependency runs the other way too, and it is the one thing a future change must not break:

> If the per-artifact origin scheme is ever changed so that several artifacts share a hostname,
> `allow-same-origin` must be removed in the same commit. A shared artifact origin plus
> `allow-same-origin` means every artifact can read every other artifact's stored data.

`allow-scripts` together with `allow-same-origin` also means the frame can remove its own sandbox
attribute and reload — a documented browser behaviour, not a bug in enclave. It gains nothing by
doing so, because the sandbox is not what isolates artifacts from each other or from the app; the
origin is. The sandbox is defence in depth on top of it.

### Content-Security-Policy

Two policies, emitted per host, because the two origins need opposite things.

**Artifact origin** permits `'unsafe-inline'` and `'unsafe-eval'` in `script-src`, plus three CDNs
(`esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`) so that React-via-import-map artifacts run at all. That
is a real widening, and it is acceptable only because the origin holds nothing but the scoped grant
cookie. It also sets `frame-ancestors` to the app origin alone, so no third-party site can frame a
private artifact and read it through a user's browser, and `base-uri 'none'` with
`form-action 'none'`.

**App origin** gets the opposite: a nonce-based `script-src` with `'strict-dynamic'` and **no**
`'unsafe-inline'` or `'unsafe-eval'`, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, HSTS, and
`nosniff`.

These are set per-host in the request proxy rather than in `next.config.ts`, because a config-level
header rule matches on path only and would put the app's `X-Frame-Options: DENY` on artifact
responses — which would block the viewer's own iframe.

`Content-Type` on stored objects comes from the extension allowlist and is never sniffed.

### Authorization, and the handoff

The artifact origin has no session and makes no authorization decisions of its own. Every decision
happens on the app origin, and the artifact origin only trusts a signed token:

1. A viewer opens `/a/{id}` (signed in, or with no session at all if the artifact is *public*) or
   `/s/{token}` (a share link) on the app origin.
2. The app authorizes the read, then mints a **handoff token**: signed, single-use, 30-second
   lifetime, bound to a specific artifact, version and viewer.
3. The viewer page frames `https://{id}.artifacts.example.com/__enter?t=…`.
4. `/__enter` validates the token, **re-checks authorization** — so a share revoked in the seconds
   since step 2 fails here — and sets a grant cookie for that subdomain only, 30-minute lifetime.
   Replaying the same token afterwards is a 404.
5. The entry document is streamed from object storage **through the app process**, with
   authorization re-checked on every single request.
6. Any other path is authorized from the grant cookie, resolved against the version's manifest by
   exact match, and answered with a redirect to a freshly minted presigned URL.

Every failure on the artifact origin — unauthorized, revoked, replayed, wrong host, unknown path —
returns the same `404` with the same body. Nothing there distinguishes "exists but you may not read
it" from "does not exist".

### Revocation: instant for the document, ≤60 s for assets

This is the sharpest edge of the design, and worth stating precisely.

| What | Revocation delay | Why |
|---|---|---|
| The entry document | Immediate | It is proxied by the app on every request, and authorization is re-checked every time. Revoke a share link and the very next document load is a 404. |
| Assets (JS, CSS, images) | Up to `PRESIGN_TTL_SECONDS`, default **60 seconds** | Asset bytes are served by object storage, not by the app, via presigned URLs. A URL already issued stays valid until it expires; enclave cannot recall it. |

So: revoke a share link and the artifact stops loading at once, but a presigned asset URL captured
in the previous minute keeps returning bytes for the rest of its 60 seconds. That is the deliberate
trade for not proxying every byte of every asset through the app process. `PRESIGN_TTL_SECONDS` is
configurable — lowering it shortens the window, at the cost of more redirects.

The same bound applies to a deleted artifact: rows and share links go immediately, objects go when
the purge job runs past the retention window, and any presigned URL issued before the delete expires
within its TTL.

## Other controls

| Area | What is done |
|---|---|
| Passwords | argon2id (m=19456, t=2, p=1). Sign-in is rate-limited per email and per IP, with one generic failure message that distinguishes nothing. |
| Sessions | HttpOnly, Secure, `SameSite=Lax`, and **host-only** — no `Domain` attribute, so an artifact origin can never see the session cookie. Rotated on sign-in, revocable server-side. |
| Share and API tokens | 32 bytes of entropy, stored only as a SHA-256 hash. The plaintext is returned exactly once, at creation, and is unrecoverable afterwards. |
| User provider keys | AES-256-GCM with `ENCRYPTION_KEY`. Never returned by any endpoint after being stored. |
| Authorization | One function (`canRead`) is the single read gate for every path, held to 100% branch coverage. Administrators are explicitly excluded from reading private artifacts. |
| Existence leaks | An unauthorized read is a `404`, never a `403`. That applies to artifacts, `/setup` after first run, and `/signup` without a redeemable invite. |
| Untrusted input | Zod schemas on request bodies and on the environment. Model output goes through a dedicated incremental parser and bundle validator instead, both held to 100% branch coverage: paths are rejected for traversal, absolute paths, backslashes, double slashes, null bytes and disallowed extensions, and only complete file blocks are ever committed — prose outside a block or an unterminated final block persists nothing. |
| SQL | Drizzle with parameterized queries throughout. No string-built SQL. |
| CSRF | `SameSite=Lax` plus an origin check on state-changing requests. |
| Audit trail | Privacy changes, share creation and revocation, deletes, restores, purges, token and invite lifecycle, sign-ins and failures, and every non-private view including anonymous ones — with the IP. Rows survive artifact purge. |
| Log hygiene | Prompts, tokens, presigned URLs and `Authorization` headers are never logged. Prompts are never written to the audit log either. |
| Error hygiene | No stack traces, bucket names or file paths in any client-facing response. |

## Known limits

Stated plainly, because a limit you know about is not a vulnerability report:

- **Artifacts can reach the network.** `connect-src` is `*` and three script CDNs are allowed, so a
  generated artifact can call out to the internet. There is no egress filtering. An artifact is code
  a user asked a model to write; treat it as such.
- **Rate limits and quotas are per process.** They are held in memory, so a multi-replica deployment
  enforces them per replica rather than globally.
- **`X-Forwarded-For` is trusted.** Every supported deployment puts a TLS-terminating proxy in
  front, so the first hop of that header is taken as the client IP. Expose the app process directly
  and the header becomes client-controlled: the per-IP sign-in rate limit can be bypassed and audit
  rows can be given arbitrary IPs. This is a deployment requirement, documented in
  [docs/self-hosting.md](docs/self-hosting.md#dns), not a defect to report.
- **Wildcard TLS is your responsibility.** Run it over plain http and the origin isolation this
  whole document rests on does not exist. The app warns at startup; it cannot refuse.
- **No published container image yet.** Build from source and verify what you run.
- **v1 has never run in production.** The privacy model is covered by 745 unit and integration tests
  and 95 browser specs, and by `scripts/fresh-clone-demo.sh`, which drives the whole authorization
  path end to end. It has no operational track record beyond that.
