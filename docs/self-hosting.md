# Self-hosting enclave

Everything an operator needs. Read [Two origins](#two-origins-and-why-it-is-not-optional) first —
it is the one part of this system you cannot skip or simplify, and getting it wrong is the
difference between artifact isolation and no isolation at all.

- [Before you start](#before-you-start)
- [Two origins, and why it is not optional](#two-origins-and-why-it-is-not-optional)
- [DNS](#dns)
- [TLS](#tls)
- [Object storage](#object-storage)
- [Bucket CORS](#bucket-cors)
- [Environment variables](#environment-variables)
- [Running it](#running-it)
- [Migrations](#migrations)
- [Scheduled jobs](#scheduled-jobs)
- [Backup and restore](#backup-and-restore)
- [Optional OIDC](#optional-oidc)
- [Operating notes](#operating-notes)
- [Troubleshooting](#troubleshooting)

## Before you start

You need:

- A domain you control, with the ability to add a **wildcard** DNS record.
- A **wildcard TLS certificate** for that wildcard, terminated by whatever sits in front of the app.
- Postgres 17 (any recent version works; 17 is what CI and the compose file use).
- An S3-compatible bucket. AWS S3, Google Cloud Storage, Cloudflare R2, Backblaze B2 and MinIO are
  all fine.
- A model provider API key if you want generation from a prompt — Anthropic, or anything that
  speaks the OpenAI Chat Completions API. Everything else works without one.

Local trial with none of the above: see the quick start in the [README](../README.md), which runs
Postgres and MinIO in containers over plain http on `localhost`. That configuration is for looking
at the product. It is not isolated (no https, so the browser gives you no origin guarantees worth
relying on) and must not be exposed.

## Two origins, and why it is not optional

enclave serves two different things from one process, and they must be two different browser
origins:

| Origin | Serves | Cookies it holds |
|---|---|---|
| `app.example.com` | The app, the API, the marketing page, share-link entry (`/s/{token}`) | The session cookie — **host-only**, never with a `Domain` attribute |
| `{artifactId}.artifacts.example.com` | One artifact's document and its asset redirects | Only a grant cookie, scoped to that single subdomain |

One origin **per artifact**, not one origin for all artifacts. That is what makes it safe to run
artifacts with `sandbox="… allow-same-origin …"`, which is in turn what lets an artifact use
`localStorage` and `IndexedDB` at all. Two artifacts on a shared origin would share that storage.
If you ever change the origin scheme so several artifacts share a host, `allow-same-origin` must be
removed in the same change — see [SECURITY.md](../SECURITY.md).

### Use a separate registrable domain

**Strong recommendation:** put artifacts on a *different registrable domain* than the app.

```
app        →  enclave.example.com
artifacts  →  {id}.example-artifacts.dev      # a separate domain you own
```

not

```
app        →  app.example.com
artifacts  →  {id}.artifacts.example.com      # same registrable domain — supported, riskier
```

The reason is cookie scope. Cookies are scoped by registrable domain, not by origin. On a shared
parent domain, one mistake — a session cookie issued with `Domain=example.com` instead of
host-only — makes that cookie readable by *every artifact*, and artifacts run arbitrary
model-generated JavaScript. A separate registrable domain removes the entire class of bug: there is
no cookie either side could set that the other would ever see.

Same-parent-domain **is** supported. enclave issues its session cookie host-only (no `Domain`
attribute) precisely so that configuration is safe. But then that one property is load-bearing:
anything you put in front of the app that rewrites `Set-Cookie` headers — some reverse proxies and
SSO gateways do — can break it silently. If you take this path, verify once, from a browser:

```
document.cookie   // on an artifact origin: must NOT contain enclave_session
```

## DNS

Two records, one of them a wildcard:

```
enclave.example.com.            A      203.0.113.10
*.example-artifacts.dev.        A      203.0.113.10
```

Both point at the same server. The app decides which origin a request belongs to by looking at the
`Host` header (or `X-Forwarded-Host` behind a proxy) and matching it against
`ARTIFACT_ORIGIN_TEMPLATE`.

Behind a reverse proxy, forward the original host. Nginx:

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Host  $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
```

`X-Forwarded-For` matters beyond hygiene: it is where the audit log gets the IP address of an
anonymous share-link view from, and what the per-IP sign-in rate limit counts.

**Do not expose the app process directly to the internet.** enclave trusts the first hop in
`X-Forwarded-For` because every supported deployment terminates TLS at a proxy. Without one in
front, that header is client-controlled — a caller can set it freely, which makes the per-IP
sign-in rate limit trivially bypassable and puts attacker-chosen values in your audit log. Make
sure the proxy *overwrites* the header rather than appending to whatever the client sent;
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` appends, so also ensure the app is
unreachable except through the proxy.

## TLS

You need a certificate covering the wildcard. A per-host certificate is not an option — artifact
hostnames contain a UUID that does not exist until the artifact is created.

Let's Encrypt issues wildcards only over the DNS-01 challenge, so you need a DNS provider your ACME
client can talk to. With certbot:

```bash
certbot certonly \
  --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d 'example-artifacts.dev' -d '*.example-artifacts.dev' \
  -d 'enclave.example.com'
```

Both `APP_URL` and `ARTIFACT_ORIGIN_TEMPLATE` must be `https://` in any real deployment. The app
logs a warning at startup when `ARTIFACT_ORIGIN_TEMPLATE` is not https, because without it the
sandbox gives you nothing.

## Object storage

Any S3-compatible bucket. The app creates the bucket on first boot if it is absent and it has
permission to; it warns and carries on if storage is unreachable, and artifact uploads then answer
`503` until it responds. Objects are written once and never mutated, under:

```
s3://<bucket>/artifacts/{artifactId}/{versionId}/{path}
```

| Backend | `S3_ENDPOINT` | `S3_FORCE_PATH_STYLE` | Notes |
|---|---|---|---|
| AWS S3 | `https://s3.<region>.amazonaws.com` | `false` | Set `S3_REGION` to the bucket's real region. |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `false` | `S3_REGION=auto`. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | `false` | Use an application key, not the master key. |
| Google Cloud Storage | `https://storage.googleapis.com` | `false` | Requires the bucket's HMAC interoperability keys, not a service-account JSON file. |
| MinIO | `http(s)://<host>:9000` | `true` | Self-hosted. Path-style addressing is required. |

The bucket must be **private**. enclave hands out short-lived presigned URLs for assets; a
world-readable bucket makes revocation meaningless because the object URL keeps working forever.

Give the credentials only what is needed: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
`s3:ListBucket` on the bucket, plus `s3:CreateBucket` if you want the app to create it for you.

### The MinIO compose profile

For a zero-configuration local trial, `docker-compose.yml` carries an optional MinIO service:

```bash
docker compose --profile minio up -d postgres minio
```

It comes up on `localhost:9000` (console on `9001`) with the development credentials already in
`.env.example`, and the app creates the bucket on first boot. This is a trial convenience, not a
deployment: the credentials are in a committed file, and the setup only works when the browser and
the app resolve `S3_ENDPOINT` to the same place — see the note in [Running it](#running-it).

## Bucket CORS

**Required.** Without it, artifacts render but any `fetch()` inside them fails.

An artifact asking for its own asset — `fetch('./data.json')` from artifact JavaScript — is a
cross-origin request the moment the app answers with a 302 to a presigned storage URL. The browser
enforces CORS on the redirect target, which is your bucket. If the bucket does not allow the
artifact origin, the fetch fails with a CORS error that names storage, not enclave, and looks like
a bug in the artifact.

Allow the wildcard artifact origin, and nothing else:

```json
[
  {
    "AllowedOrigins": ["https://*.example-artifacts.dev"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Type", "ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Apply it:

```bash
# AWS S3 / R2 / B2 (the file above, saved as cors.json)
aws s3api put-bucket-cors --bucket enclave-artifacts --cors-configuration file://cors.json

# MinIO
mc admin config set local api cors_allow_origin='https://*.example-artifacts.dev'
```

`GET` and `HEAD` are enough — nothing ever uploads from a browser. Every write goes through the app
with server-side credentials.

Do not add the app origin to this list. The app talks to storage server-side, where CORS does not
apply, and listing it would only widen what a browser can reach.

## Environment variables

Every variable is validated at startup by `src/env.ts`. A missing or malformed one exits the
process non-zero and names the offender **before** a port is bound, so a misconfigured instance
fails to start rather than half-working. `.env.example` is the committed template; copy it and edit.

### App

| Variable | Required | Example | What it does |
|---|---|---|---|
| `APP_URL` | yes | `https://enclave.example.com` | The app's public origin. Share links, invite links and the OIDC redirect URI are all built from it. Must be the URL users actually reach. |
| `ARTIFACT_ORIGIN_TEMPLATE` | yes | `https://{id}.example-artifacts.dev` | The artifact origin pattern. **Must contain `{id}`.** Startup fails without it. This is also how inbound requests are recognised as artifact-origin requests. |

### Database

| Variable | Required | Example | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | `postgresql://enclave:secret@db.internal:5432/enclave` | Postgres connection string. Note that `.env.example` uses port **5434** — that is the host-side port the compose file publishes, chosen because 5432 and 5433 commonly collide with a locally installed Postgres. Inside the compose network the app talks to `postgres:5432`, which `docker-compose.yml` sets for you. |

### Object storage

| Variable | Required | Example | What it does |
|---|---|---|---|
| `S3_ENDPOINT` | yes | `https://s3.eu-west-1.amazonaws.com` | Storage API endpoint the **server** dials. |
| `S3_PUBLIC_ENDPOINT` | no | `http://localhost:9000` | The endpoint presigned URLs are signed with, i.e. the one **browsers** must reach. Defaults to `S3_ENDPOINT`; only set it when the two differ, such as the bundled MinIO profile. |
| `S3_REGION` | yes | `eu-west-1` | Region. `auto` for R2, `us-east-1` for MinIO. |
| `S3_BUCKET` | yes | `enclave-artifacts` | Bucket name. Created on boot if absent and permitted. |
| `S3_ACCESS_KEY_ID` | yes | — | Access key. |
| `S3_SECRET_ACCESS_KEY` | yes | — | Secret key. |
| `S3_FORCE_PATH_STYLE` | no (`true`) | `false` | Path-style addressing. `true` for MinIO, `false` for AWS S3, R2, B2 and GCS. |

### Secrets

Both must be at least 32 bytes. Generate each separately:

```bash
openssl rand -base64 48
```

| Variable | Required | What it does |
|---|---|---|
| `SESSION_SECRET` | yes | Signs session cookies, artifact grant cookies and handoff tokens. Rotating it invalidates every session and every open viewer. |
| `ENCRYPTION_KEY` | yes | AES-256-GCM key for provider API keys that users store in their own settings. **Rotating this makes every stored user key undecryptable** — users must re-enter them. Back it up with the same care as the database. |

### Model providers

At least one key is needed to generate from a prompt. The app starts and serves everything else
without any: the generate endpoint answers `400 PROVIDER_KEY_INVALID`, and `POST /api/v1/artifacts`
keeps working, because pushing a bundle needs no model.

| Variable | Required | Example | What it does |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | no | `sk-ant-…` | Instance-wide Anthropic key. Preferred when both are set. |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint — a local model server, a gateway, a different vendor. |
| `OPENAI_API_KEY` | no | — | Key for that endpoint. |
| `DEFAULT_MODEL` | yes | `claude-sonnet-4-6` | Model identifier passed to whichever provider is selected. |

Users can store their own key per provider in settings; theirs takes precedence over the instance
key, and they get the larger `QUOTA_GENERATIONS_PER_DAY_OWN_KEY` when it is used.

### Registration

| Variable | Required | Default | What it does |
|---|---|---|---|
| `ALLOW_OPEN_REGISTRATION` | no | `false` | `true` means anyone who can reach `/signup` becomes a member. Understand the consequence: "visible to the organization" then means visible to anyone who signs up. Leave it `false` and use invites unless the instance is deliberately public. |

### Rate limits and quotas

| Variable | Required | Default | What it does |
|---|---|---|---|
| `RATE_LIMIT_GENERATIONS_PER_HOUR` | no | `10` | Per-user generation attempts per hour. Exceeding it returns `429 RATE_LIMITED` with `Retry-After`. |
| `QUOTA_GENERATIONS_PER_DAY` | no | `100` | Per-user daily generations on the instance key. |
| `QUOTA_GENERATIONS_PER_DAY_OWN_KEY` | no | `1000` | Per-user daily generations when the user brought their own key — their spend, so a looser cap. |
| `RATE_LIMIT_AUTH_PER_IP_PER_HOUR` | no | `30` | Per-IP cap on sign-in and first-run setup attempts. Needs correct `X-Forwarded-For` behind a proxy, or every request looks like it came from the proxy. |

Counters are per user and held in the process. A multi-instance deployment therefore enforces these
per instance, not globally — divide the numbers by your replica count, or run one instance.

### Bundle limits

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BUNDLE_MAX_FILES` | no | `50` | Files per bundle. Over it: `413 BUNDLE_TOO_LARGE`. |
| `BUNDLE_MAX_TOTAL_BYTES` | no | `10485760` (10 MB) | Total bundle size. The HTTP request-body ceiling is derived from it, and that derivation happens when `next.config.ts` is evaluated — which is at build time for the standalone Docker image. Raising this in the container's environment alone will not raise the body limit; rebuild the image. Running from a checkout re-reads it at start. |
| `BUNDLE_MAX_FILE_BYTES` | no | `2097152` (2 MB) | Largest single file. |

File extensions are restricted to a fixed allowlist regardless of these values: `html css js mjs
json svg png jpg jpeg webp woff2 txt md`. It is a constant in `src/lib/bundle/validate.ts`, not an
environment variable — each entry also fixes the `Content-Type` the object is stored with, so the
list and the served type cannot drift apart.

### Token lifetimes, in seconds

| Variable | Required | Default | What it does |
|---|---|---|---|
| `PRESIGN_TTL_SECONDS` | no | `60` | Lifetime of a presigned asset URL. **This is your revocation window for assets** — a link already handed out keeps working this long after you revoke. Raising it trades revocation speed for fewer redirects. |
| `HANDOFF_TTL_SECONDS` | no | `30` | Lifetime of the single-use token that carries authorization from the app origin to the artifact origin. Raise it only if you have very slow clients. |
| `ARTIFACT_GRANT_TTL_SECONDS` | no | `1800` (30 min) | How long a viewer can keep reading one artifact before the app re-authorizes. This is the ceiling on how stale an *asset-path* authorization can be; the entry document is re-checked on every request regardless. |

### Retention, in days

| Variable | Required | Default | What it does |
|---|---|---|---|
| `TRASH_RETENTION_DAYS` | no | `30` | How long a deleted artifact can be restored. After this, the purge job removes rows and objects. Share links are killed at delete time, not at purge time. |
| `AUDIT_RETENTION_DAYS` | no | `365` | How long audit rows are kept. Audit rows survive artifact purge, keeping `artifact_id` — that is deliberate, so a deletion is still accountable. |

### Retention windows are exact hours, not calendar days

Every deadline is stored as `timestamp with time zone`, so Postgres always holds an absolute
instant. Retention math uses `make_interval(hours => N * 24)` rather than `days => N`: hour-field
intervals do not consult the session `TimeZone`, so a 30-day window is exactly 720 hours even
across DST transitions and regardless of the database server's `timezone` GUC. The app also pins
process `TZ` and the pooled session `TimeZone` to UTC so any remaining day/month arithmetic and
`now()` rendering stay consistent — that pin is belt-and-braces for display, not what makes the
hour window exact.

## Running it

The app is one Next.js process. Two shapes work:

### A. App on the host, dependencies in containers

What CI and `scripts/fresh-clone-demo.sh` do, and the simplest thing to debug:

```bash
docker compose up -d postgres          # or: --profile minio up -d postgres minio
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

Put a TLS-terminating reverse proxy in front of port 3000 and you have a working deployment. Use a
process supervisor (systemd, pm2) so it restarts.

### B. Everything in containers

`docker-compose.yml` includes the app service and builds it from the `Dockerfile`:

```bash
docker compose up -d --build
docker compose run --rm app pnpm db:migrate
```

The image is a multi-stage build producing a Next.js standalone bundle, running as a non-root user,
with a `/healthz` healthcheck and a startup preflight that exits non-zero on a bad environment
before binding the port.

**No image is published to a registry yet.** Build it yourself, as the compose file does, or push it
to your own registry and replace the `build:` block with `image:`. There is a
`.github/workflows/release.yml` that builds `linux/amd64` and `linux/arm64` and pushes to GHCR when
the maintainer tags a release; until such a tag exists, building from source is the only option and
`docker-compose.yml` reflects that.

**Two endpoints, when the browser cannot reach the one the server uses.** The app dials storage at
`S3_ENDPOINT`, but a presigned URL is followed by the *browser* and signs its own host, so it cannot
simply be rewritten afterwards. With AWS S3, R2, B2 and GCS this never comes up — one public
endpoint serves both. It does come up with the bundled MinIO profile, where the app container
resolves `http://minio:9000` on the compose network while the browser resolves
`http://localhost:9000`. Set `S3_PUBLIC_ENDPOINT` to the browser's value and presigning uses it:

```
S3_ENDPOINT=http://minio:9000            # what the app container dials
S3_PUBLIC_ENDPOINT=http://localhost:9000 # what a presigned URL is signed with
```

`docker-compose.yml` already wires both from `.env` (`S3_ENDPOINT_INTERNAL` and
`S3_PUBLIC_ENDPOINT`). Leave `S3_PUBLIC_ENDPOINT` unset for any provider with a single endpoint —
it defaults to `S3_ENDPOINT`. The same split covers a private VPC endpoint fronted by a public host.

### Health checks

`GET /healthz` returns `200` when the process can serve requests, which includes reaching Postgres,
and `503` when it cannot. It deliberately does **not** probe object storage: an unreachable bucket
degrades artifact serving but should not pull the whole instance out of a load balancer.

## Migrations

Migrations are SQL files under `drizzle/`, applied in order:

```bash
pnpm db:migrate                          # from a checkout
docker compose run --rm app pnpm db:migrate   # from the image
```

Run them before starting a new version. They are additive in v1; there is no rollback script — take
a database snapshot first (see below).

## Scheduled jobs

Three entry points under `scripts/`. None of them run themselves — nothing in the app schedules
anything, so if you do not wire these up, trash is never purged and audit rows accumulate forever.

| Script | How often | What it does | Exit code |
|---|---|---|---|
| `scripts/sweep-pending.ts` | every minute | Reclaims artifact versions left `pending` for 15 minutes by a write that died mid-flight — a killed generation, a storage outage. Objects go first, then the row, so a storage failure leaves the row for the next run rather than an orphaned prefix. | Non-zero if any version was deferred — the next run retries. |
| `scripts/purge-trash.ts` | daily | Permanently removes artifacts past `TRASH_RETENTION_DAYS`: storage objects first, then rows. Audit rows survive. | Non-zero if any artifact was deferred. |
| `scripts/prune-audit.ts` | daily | Deletes audit rows past `AUDIT_RETENTION_DAYS`. | Always 0. |

Run them with `tsx`, which resolves the path aliases their imports use:

```cron
* * * * *   cd /srv/enclave && pnpm exec tsx scripts/sweep-pending.ts >> /var/log/enclave-sweep.log 2>&1
17 3 * * *  cd /srv/enclave && pnpm exec tsx scripts/purge-trash.ts   >> /var/log/enclave-purge.log 2>&1
34 3 * * *  cd /srv/enclave && pnpm exec tsx scripts/prune-audit.ts   >> /var/log/enclave-audit.log 2>&1
```

From the image, the same commands work through compose:

```bash
docker compose run --rm app pnpm exec tsx scripts/purge-trash.ts
```

Each job is idempotent and safe to run concurrently with the app. Non-zero exits mean "some work was
deferred", not "corrupted" — the next run picks it up. Alert on repeated failures, since a purge job
that never succeeds means deleted data is still on disk.

### One-shot: classify existing artifacts

Uploads that happened before an admin turned `auto_categorize_enabled` on were never tagged. After
opting in, run this once:

```bash
pnpm exec tsx scripts/classify-backfill.ts --dry-run     # preview, no provider calls
pnpm exec tsx scripts/classify-backfill.ts --limit 50    # then a sized first pass
# or: docker compose run --rm app pnpm exec tsx scripts/classify-backfill.ts
```

| Flag | Effect |
|---|---|
| `--dry-run` | Lists what would be classified and exits without a single provider call. |
| `--limit <n>` | Caps the run at the first `n` eligible artifacts, oldest first. |
| `--owner <userId>` | Restricts the run to one owner's artifacts. |

It only considers live artifacts whose `category_source` is still `model` and that have no tags. A
manual tag set is never rewritten. The same gates as a live upload apply (setting off, no instance
key, empty taxonomy). Every artifact it tags writes an `artifact.auto_tag` audit row with no actor,
since the server did the tagging. The exit code is non-zero when any eligible artifact ended the run
untagged, so alert on it the way you alert on the scheduled jobs.

**Re-running is safe, but it is not free.** Every eligible artifact costs one provider call per run.
An artifact the classifier legitimately matched to no category keeps `category_source = 'model'` with
no tag rows, which is exactly the eligibility predicate, so it is re-submitted on every later run,
forever. Preview with `--dry-run` and size the first pass with `--limit` instead of re-running the
whole instance.

Two operators running the script at once each pay for the same artifact. The final state stays
consistent, because the tag write is one transaction and the primary key rejects duplicate rows, so
concurrency here wastes money rather than corrupting data.

## Backup and restore

**Two systems hold your data, and a backup of one is worthless without the other.**

| System | Holds | If you lose it |
|---|---|---|
| Postgres | Users, artifacts, versions and their manifests, share links, API tokens, encrypted user provider keys, quotas, the audit log | Objects are orphaned bytes. Nothing knows which file belongs to which artifact, or who may read it. |
| Object storage | Every file of every artifact version | Every artifact is a row pointing at nothing. The app answers `503`, not "gone". |

Plus one secret: `ENCRYPTION_KEY`. Restore a database without it and every user-stored provider key
is unrecoverable ciphertext. Keep it wherever you keep the rest of your secrets, and back that up.

They must be captured close together in time, and the ordering that fails safe is **objects first,
then the database**. Objects are immutable and append-only, so an object backup taken slightly
earlier than the database can only be missing objects for versions the database calls `pending` —
which is exactly the state the sweeper handles. The reverse order can leave a restored database
referencing objects the backup never saw.

```bash
# 1. objects (any S3 client; --delete only if you are mirroring, never on the first run)
aws s3 sync s3://enclave-artifacts/ /backup/enclave-objects/

# 2. database
pg_dump --format=custom --no-owner "$DATABASE_URL" > /backup/enclave-$(date +%F).dump

# restore
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" /backup/enclave-2026-08-01.dump
aws s3 sync /backup/enclave-objects/ s3://enclave-artifacts/
```

If your storage provider offers versioning or object-lock, turn it on. It is the cheapest protection
against an over-eager purge job, and enclave never mutates an object so versioning costs almost
nothing.

Test a restore before you need one. A restore that has never been tried is a plan, not a backup.

## Optional OIDC

Set all three and a sign-in-with-provider option appears alongside email and password:

| Variable | Example |
|---|---|
| `OIDC_ISSUER` | `https://accounts.google.com` |
| `OIDC_CLIENT_ID` | — |
| `OIDC_CLIENT_SECRET` | — |

The redirect URI to register with your provider is built from `APP_URL`:

```
https://enclave.example.com/api/auth/oidc/callback
```

OIDC does not bypass the registration rule. With `ALLOW_OPEN_REGISTRATION=false`, a first-time OIDC
sign-in still needs an outstanding invite **addressed to the email the provider asserts** — a
link-only invite with no email on it cannot authorize an OIDC signup, because there is no token in
the callback to match it against. Issue invites with the email filled in if your users sign in this
way. The invite is claimed in the same transaction that creates the account, so a sign-in that lost
the race never burns it.

This is deliberate: an OIDC issuer you do not control would otherwise be an open door onto your
instance.

## Operating notes

- **The first account is an administrator, and `/setup` is single-use.** `GET /setup` returns 200
  only while the `users` table is empty; after that it is a 404, not a 403. Two concurrent submits
  produce exactly one administrator and one `409`. There is no way to re-open it short of emptying
  the table.
- **Administrators cannot read private artifacts.** Not a UI omission — the read gate excludes them,
  and an administrator requesting another user's private artifact gets a `404`. If you need access
  to content, you need the owner.
- **Deleting a user who still owns any artifact is blocked** rather than cascading — private,
  organization-visible, or sitting in the trash. The admin console names the counts. Reassign or
  delete the artifacts first. Deactivation is the usual answer instead.
- **Deactivating a user** kills their sessions immediately: `is_active` is re-read on every request,
  so the next one fails. They lose write access, and their organization-visible artifacts stay
  visible.
- **Logs never contain** prompts, tokens, presigned URLs or `Authorization` headers. Client-facing
  errors never contain stack traces, bucket names or file paths. Keep that true in anything you add
  in front of the app — a proxy access log that records full query strings will capture share tokens
  from `/s/{token}` URLs.

## Troubleshooting

**The process exits immediately with `[enclave] refusing to start.`**
The environment failed validation and the message names each offending variable. Most common:
a `SESSION_SECRET` or `ENCRYPTION_KEY` under 32 bytes, or `ARTIFACT_ORIGIN_TEMPLATE` missing `{id}`.

**Startup warns about `ARTIFACT_ORIGIN_TEMPLATE` not being https.**
Expected in local development, a real problem anywhere else. Without https the browser gives you no
origin isolation, so the sandbox is decorative.

**Artifacts show a browser certificate error.**
The wildcard certificate does not cover the artifact hostname. Check that the certificate includes
`*.<artifact domain>` and that the proxy presents it for those hosts.

**The artifact loads but every `fetch()` inside it fails with a CORS error.**
[Bucket CORS](#bucket-cors) is missing or does not match your artifact origin. The error names your
storage host, which makes it look like an artifact bug.

**Artifact views 404 for the owner, immediately after creating them.**
The `Host` header is not reaching the app, so every request looks like an app-origin request. Check
`proxy_set_header Host` and `X-Forwarded-Host` on the reverse proxy.

**Uploads answer `503 STORAGE_UNAVAILABLE` and the log warned about storage at boot.**
Object storage is unreachable or the credentials cannot see the bucket. Verify `S3_ENDPOINT` from
*inside* whatever runs the app, and check `S3_FORCE_PATH_STYLE` matches the backend (`true` for
MinIO, `false` for the rest).

**Generation answers `400 PROVIDER_KEY_INVALID`.**
No instance key and no user key. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and restart, or have
the user add their own in settings.

**Generation answers `502 MALFORMED_MODEL_OUTPUT`.**
The model did not emit the tagged file format, usually because `DEFAULT_MODEL` points at something
too small to follow the instruction. Nothing is persisted when this happens. Try a more capable
model.

**Versions pile up as `pending`.**
`scripts/sweep-pending.ts` is not scheduled, or it is failing. Check its log.

**Deleted artifacts never disappear from storage.**
`scripts/purge-trash.ts` is not scheduled, or it exits non-zero every run. Its log names how many
artifacts were deferred.
