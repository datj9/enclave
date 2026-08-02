# Releasing the CLI

The CLI ships to npm as [`enclave-artifacts`](https://www.npmjs.com/package/enclave-artifacts).
The server image ships separately on a `v*` tag; the CLI uses **`cli-v*`** so the two release on
their own cadences.

Releases are built and published by GitHub Actions using npm trusted publishing. No npm token is
stored in the repository.

## One-time setup

`0.1.0` was published by hand, because a trusted publisher attaches to a package that already
exists — npm has no equivalent of PyPI's pending publisher. That is done; it does not recur.

1. **npmjs.com** → `enclave-artifacts` → Settings → Trusted Publisher → GitHub Actions:

   - Organization or user: `datj9`
   - Repository: `enclave`
   - Workflow filename: `release-cli.yml`
   - Environment: `npm`

2. **GitHub** → Settings → Environments → New environment → `npm`, with a required reviewer.

   This is the approval gate. The build runs unattended; publishing waits for a human.

## Publish a version

1. Bump `version` in `packages/cli/package.json`. It is the only place the CLI's version lives,
   and the workflow refuses a tag that disagrees with it.

2. Verify locally, the same way CI will:

   ```bash
   pnpm typecheck && pnpm lint && pnpm test
   pnpm build:cli
   cd packages/cli && npm pack
   npm i -g --prefix /tmp/cli-check ./enclave-artifacts-*.tgz
   /tmp/cli-check/bin/enclave --help
   ```

3. Merge the version bump to `main`, then tag that exact commit and push the tag:

   ```bash
   git tag -a cli-v0.1.1 -m "enclave-artifacts 0.1.1"
   git push origin cli-v0.1.1
   ```

4. Approve the `npm` environment when Actions asks. The workflow publishes the artifact the build
   job already installed and ran — not a rebuild of it.

5. Confirm from outside:

   ```bash
   npx enclave-artifacts@0.1.1 --help
   ```

## Why the pipeline installs the tarball

`npm publish` accepts a manifest whose `bin` path it considers malformed: it drops the entry, warns,
and publishes successfully. The result is a CLI package with no command. Typecheck, lint and the
full test suite all pass on it — the fault exists only in the packaged artifact.

That nearly shipped in `0.1.0` and was caught by an unrelated 403. So the build job installs the
tarball into a temporary prefix and runs the binary, and fails if the executable is missing or if a
usage error puts anything on stdout under `--json`.

**A published version cannot be replaced.** npm permits unpublish only within 72 hours and only
when nothing depends on the version. Fix a bad release with a new version number.

## What ships

The tarball contains `dist/` and this README — around 17 kB, 20 files. No sources, no tests.

It carries one compiled file from outside `packages/`: `dist/src/lib/bundle/rules.js`. That is
deliberate. The bundle rules — the extension allowlist, the path pattern, the entry filename — are
defined once in `src/lib/bundle/rules.ts` and read by both the server, which enforces them, and the
CLI, which applies them early so a push does not spend an upload on a file the server would reject.
They used to be duplicated. A client that accepted more than the server is the failure that
matters, so they are not duplicated any more.
