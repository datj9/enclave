# enclave

Self-hostable artifact generation and hosting. Describe what you want, a model writes a
multi-file HTML bundle, and the result is hosted with an audience you choose and can take back.

> **Early software.** This is v1 — the first release, tagged from a repo that has never been run
> anywhere but its author's machine and CI. The privacy model is covered by tests (see
> [Testing](#testing)) but nothing here has production mileage. Read
> [SECURITY.md](SECURITY.md) before you host anything you care about, and expect to read the
> code when something surprises you.

## The three privacy levels

Every artifact starts at the first level. The third is additive — a link is a capability you hand
out, not a switch you flip.

| Level | Who can read it | How it is revoked |
|---|---|---|
| **Only me** | The owner. Nobody else, including administrators. | It is the default. |
| **Organization** | Every active account on this instance, read-only. The owner stays the sole editor. | Set the artifact back to *Only me*. |
| **Anyone with the link** | Whoever holds a share link. No account, no sign-in. | Revoke the link. Each link is separate, pinned to one version, and can carry an expiry. |

Revocation is not eventually-consistent theatre. The entry document is proxied through the app on
every request, so revoking is immediate for the document; assets are served by presigned URLs with
a 60-second lifetime, so a link already in someone's hands stops working within a minute.
Administrators can manage users, quotas and the audit log, and cannot read a private artifact —
that is enforced in the one read gate every path goes through, not by convention.

## Quick start

Postgres and object storage run in containers; the app runs on your machine. Five commands:

```bash
git clone https://github.com/datj9/enclave.git && cd enclave
cp .env.example .env
docker compose --profile minio up -d postgres minio
pnpm install && pnpm db:migrate && pnpm build
pnpm start        # then open http://localhost:3000/setup
```

`/setup` creates the single administrator account and then stops existing. Everything works from
there **except generating from a prompt**, which needs a model provider API key — add
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `.env` and restart. You can push bundles through
`POST /api/v1/artifacts` without any key at all.

To check the whole path end to end, including the origin isolation and the share-then-revoke
journey, run the demo:

```bash
bash scripts/fresh-clone-demo.sh
```

It drives all ten steps against a throwaway database and fails loudly on the first broken one.
Without a provider key it reports the generation step as skipped and continues.

For a real deployment — wildcard DNS, wildcard TLS, bucket CORS, every environment variable, and
the backup story — read [docs/self-hosting.md](docs/self-hosting.md). Do not put this on the
internet from the quick start above.

## What v1 does

- **Generate** a multi-file bundle from one prompt, streamed as it arrives. Anthropic or any
  OpenAI-compatible endpoint. Instance key by default, or bring your own per account.
- **Host** each artifact on its own origin (`{id}.artifacts.<domain>`) inside a sandboxed iframe
  with a strict Content-Security-Policy, so one artifact cannot reach another's storage or the
  app's session.
- **Version** append-only. A share link pins one version and keeps showing it after you publish
  newer ones.
- **Share** with revocable capability links: 32 bytes of entropy, stored only as a hash, optional
  expiry, per-link revocation.
- **Push** bundles from anything that speaks HTTP: `POST /api/v1/artifacts` with a scoped API
  token (`artifacts:read`, `artifacts:write`, `shares:write`).
- **Audit** every privacy change, share creation and revocation, and every non-private view,
  including anonymous ones, with a viewer for administrators. Prompts are never written to the
  audit log.
- **Limit** abuse with a per-user hourly rate limit and a daily generation quota, both configurable,
  with a larger quota for accounts using their own provider key.
- **Delete** softly: a 30-day trash window that kills every share link immediately, then a purge
  job that removes the database rows and the storage objects while the audit trail survives.
- **Invite** rather than accept open signups, unless you set `ALLOW_OPEN_REGISTRATION=true`.
  Email and password (argon2id), or OIDC.

## What v1 does not do

Named explicitly so you can stop looking: multi-turn chat, iterating on an existing artifact,
diffing versions, forking or remixing, multiple organizations in one deployment, collaborative
editing, per-artifact editor permissions, comments, an embed-on-other-sites mode, templates,
full-text search, webhooks, usage billing, and SCIM provisioning. None of these are present.

## Stack

Next.js (App Router) · Postgres via Drizzle · any S3-compatible object storage · Docker Compose.
Vitest for unit and integration tests, Playwright for browser journeys.

## Testing

```bash
pnpm test          # 745 unit + integration tests
pnpm test:e2e      # 95 Playwright specs across 9 journeys
pnpm test:coverage # 80% floor repo-wide; 100% branches on the bundle parser and the read gate
```

Integration tests skip themselves when Postgres or object storage is unreachable, so `pnpm test`
passes on a machine with nothing started. Start the compose services to actually run them.

## Docs

| File | What is in it |
|---|---|
| [docs/self-hosting.md](docs/self-hosting.md) | The operator's guide: DNS, TLS, CORS, every env var, storage backends, cron jobs, backup |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability, and exactly how artifact isolation works |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Test commands, coverage floor, TDD order, the binding design references |
| [design.md](design.md) | The locked design system — colour, type, space, depth |
| [docs/motion.md](docs/motion.md) | The in-app motion standard: durations, curves, what animates and what does not |

## License

[Apache-2.0](LICENSE). Copyright 2026 Dat Nguyen.
