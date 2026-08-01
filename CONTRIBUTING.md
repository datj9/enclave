# Contributing to enclave

Bug reports and patches are welcome. Vulnerabilities are not — those go through
[SECURITY.md](SECURITY.md), not the issue tracker.

## Getting a working checkout

```bash
git clone https://github.com/datj9/enclave.git && cd enclave
cp .env.example .env
docker compose --profile minio up -d postgres minio
pnpm install
pnpm db:migrate
pnpm dev
```

Node 24+ and pnpm 9.15.0 (`corepack enable` gets you the right pnpm). The compose services publish
Postgres on **5434** and MinIO on **9000** — both are what `.env.example`, CI, and the integration
tests already expect, so nothing needs editing.

Generation from a prompt needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `.env`. Everything else,
including pushing bundles through `POST /api/v1/artifacts`, works without one.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc --noEmit`. Zero errors, always. |
| `pnpm lint` | ESLint over the whole repo. Zero warnings. |
| `pnpm test` | Vitest: unit and integration. |
| `pnpm test:watch` | The same, watching. |
| `pnpm test:coverage` | Vitest with coverage and the thresholds enforced. |
| `pnpm test:e2e` | Playwright browser journeys. Needs a built app — it starts `pnpm start` itself. |
| `pnpm build` | Production build. |
| `pnpm db:generate` | Generate a migration from a schema change. |
| `pnpm db:migrate` | Apply pending migrations. |
| `bash scripts/fresh-clone-demo.sh` | The whole v1 done definition, end to end, against a throwaway database. |

Before opening a merge request, all of these must pass:

```bash
pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build && pnpm test:e2e
```

That is the same sequence CI runs, in the same order — see `.github/workflows/ci.yml`.

## Tests

Vitest for unit and integration, Playwright for browser journeys. Not Jest, not Enzyme.

```
tests/unit/          pure logic, no I/O
tests/integration/   real Postgres and real object storage
tests/e2e/           Playwright, one file per user journey
```

Integration tests probe for Postgres and object storage and **skip themselves** when either is
absent, so `pnpm test` passes on a machine with nothing started. That is a convenience, not a pass —
start the compose services before you claim a change is tested.

### The coverage floor is 80%

Lines, functions, branches and statements, repo-wide, enforced by `pnpm test:coverage`. Three
modules are held to **100% of branches** because they are the ones a mistake in is not recoverable:

| Module | Why |
|---|---|
| `src/lib/artifacts/can-read.ts` | The single read gate. Every authorization decision in the product goes through it. |
| `src/lib/bundle/validate.ts` | Rejects path traversal, oversized bundles and disallowed file types before anything is written. |
| `src/lib/bundle/parse-file-blocks.ts` | Parses untrusted model output into file paths. |

If you touch any of those three, expect the reviewer to read your tests before your implementation.

### Write the test first

Red, green, refactor, in that order:

1. Write the failing test. One scenario per test, named
   `<action>_<condition>_<expected result>`.
2. Run it. Watch it fail for the reason you expect. A test that passes before the implementation
   exists is testing nothing.
3. Write the smallest implementation that makes it pass.
4. Run it again.
5. Refactor only while green.
6. `pnpm test:coverage` before you call it done.

Test behaviour, not implementation. Assert the specific value, never just "truthy". Cover the happy
path, the empty case, the error case, the boundary, and the unauthorized case — that last one is not
optional in this codebase.

## Design references — binding, not suggestions

Two files govern how the interface looks and moves. They are the rule; a merge request that
contradicts them gets changed, not the file.

- **[design.md](design.md)** — colour, type, space, depth, and the marketing page's structure. The
  tokens in it are canonical. Anchor hue 60 with a single amber accent is a deliberate choice, not
  a default to be improved on. There are no gradients in this system, one shadow, and never a
  coloured glow.
- **[docs/motion.md](docs/motion.md)** — in-app motion: which curve, which duration, and — more
  often — whether the thing should animate at all. Start with its frequency table. Anything a user
  sees a hundred times a day does not animate, and a keyboard-initiated action never animates.

Where the two disagree, `docs/motion.md` wins inside the app and `design.md` wins on the marketing
page. Amend either file deliberately, in its own commit, with the reasoning — do not work around it
locally.

Artifact contents are explicitly out of scope for both. What renders inside the sandboxed iframe
belongs to whoever generated it; style the chrome around the frame and nothing inside it.

## Code

The full rules live in `.claude/rules/` (not committed — it is the author's local harness). The parts
that will come up in review:

- **No `any`.** `unknown` plus a type guard, or fix the type.
- **Immutability.** Return new objects; do not mutate arguments.
- **Validate at every boundary.** Zod schemas on request bodies, environment, and model output.
- **Descriptive names.** No `tmp`, `data`, `val`, `obj`, `res`. Booleans read as `is`/`has`/`should`.
  Collections are plural.
- **Comments earn their place.** Write one for a *why* the code cannot state — a constraint, a
  rejected alternative, a non-local dependency, a deliberate oddity. Never restate the code, and
  never write a comment longer than the code it introduces.
- **Files under 800 lines, functions under 50.** Split by feature, not by technical type.
- **Handle every error explicitly.** Client-facing messages stay useful and leak nothing; server
  logs carry the detail. Never log prompts, tokens, presigned URLs or `Authorization` headers.

## Commits and merge requests

Conventional commits, subject in the imperative and under 72 characters:

```
feat(shares): add optional expiry to share links
fix(viewer): read the expiry clock as an epoch, not a timestamp
test(trash): cover the retention boundary
docs: document bucket CORS for artifact fetch
```

One isolated change per commit. Branch from `master` as `<type>/<short-slug>`.

In the merge request, say what changed and how to test it. Link the issue rather than restating it.
If the change touches the two-origin handoff, the Content-Security-Policy, or `canRead`, say so
prominently — those three get a security review, and a change to the origin model has a specific
consequence spelled out in [SECURITY.md](SECURITY.md).
