# enclave-artifacts

Command-line client for [enclave](https://github.com/datj9/enclave) — self-hostable artifact
generation and hosting. Publish a local directory to your instance and manage what you have
published, without opening a browser.

This is the client. It talks to an enclave server you run yourself; it is not useful on its own.

> **Early software.** First release. The server it talks to has never run anywhere but its
> author's machine and CI.

## Install

```bash
npm install -g enclave-artifacts
```

Or run it without installing:

```bash
npx enclave-artifacts push ./dist
```

The command is `enclave` either way.

## Getting started

```bash
enclave login --host enclave.example.com
enclave push ./dist --title "Kanban board"
```

`login` prints where to mint a token and reads it with the input masked (`*` per character,
nothing echoed to the terminal). The token needs three scopes — `artifacts:read`,
`artifacts:write` and `shares:write` — and is stored per host in
`~/.config/enclave/credentials.json` with mode `0600`. `ENCLAVE_TOKEN` overrides the file, which is
what you want in CI. `--token <token>` skips the interactive prompt entirely — the other option
for CI, or for a terminal that cannot mask input correctly.

`push` writes `.enclave.json` next to the directory it published, recording which artifact the
directory maps to. **Commit that file** — it holds no secret, and committing it is what lets a
second machine or a CI job target the same artifact.

`--host` accepts a bare authority (`enclave.example.com`, `127.0.0.1:3000`, `[::1]:3000`) or a
full `http`/`https` origin, with or without a trailing slash. Only `scheme://host[:port]` is
accepted — a path suffix (e.g. `enclave.example.com/settings/tokens`) is rejected rather than
silently truncated, since that can retarget every authenticated request to the wrong origin. An
explicit scheme is always honoured; otherwise `enclave` uses `http` for `localhost`, `127.0.0.1`
and `[::1]`, and `https` everywhere else.

An explicit `http://` origin that isn't loopback is refused, since it would send the bearer token
in cleartext. Pass `--insecure` to opt in anyway.

## Commands

```
enclave version  [--json]              (also -v, -V, --version)
enclave login    [--host <host>] [--token <token>]
enclave logout   [--host <host>]

enclave push     <dir> [--title <t>] [--visibility private|org|public]
                       [--new] [--dry-run] [--json]
enclave list     [--limit <n>] [--cursor <c>] [--json]
enclave show     <id> [--json]
enclave rename   <id> <title>
enclave privacy  <id> private|org|public
enclave rm       <id>
enclave restore  <id>

enclave share create <id> [--version <versionId>] [--expires <7d|ISO>] [--json]
enclave share list   <id> [--json]
enclave share revoke <shareId>
```

`<id>` takes a full artifact uuid or any unambiguous prefix of eight characters or more.

The host resolves from `--host`, then `ENCLAVE_HOST`. `push` also falls back to `.enclave.json`.
The token resolves from `--token`, then `ENCLAVE_TOKEN`, then the stored credentials — `login`
included, so it runs unattended in CI.

Flags are scoped to the command that declares them. A flag a command does not take exits `2`
rather than being silently discarded — `enclave rm <id> --dry-run` refuses instead of deleting.

## What gets uploaded

The server accepts thirteen file types — `html css js mjs json svg png jpg jpeg webp woff2 txt md`
— with paths matching `[a-zA-Z0-9._-/]` and no spaces. A bundle is validated as a unit, so one
disallowed file rejects the whole upload.

Rather than let that happen, `push` drops what the server would refuse and **prints every file it
skipped, with the reason**. A typical `dist/` loses its sourcemaps and favicon and uploads fine:

```
$ enclave push ./dist
skipped 3 files:
  app.js.map        unsupported (.map)
  favicon.ico       unsupported (.ico)
  fonts/Inter.ttf   unsupported (.ttf)
✓ 2 files, 40 KB
✓ created 3f2a91c4  v1
→ https://3f2a91c4-….artifacts.example.com
```

Use `.enclaveignore` (gitignore syntax) to drop more. `--dry-run` shows the split without
uploading anything.

The client's copy of these rules is a convenience so a push does not spend an upload learning a
file was never going to be accepted. **The server is authoritative** and enforces them regardless.

## Scripting

Every command takes `--json`, which puts the raw API object on stdout and **nothing else** —
errors and diagnostics always go to stderr, so `| jq` is safe on every path.

| Exit code | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `0`       | Success                                                                      |
| `1`       | Ran, and the answer was no — not found, refused, unreachable, token rejected |
| `2`       | Malformed invocation; the command never ran                                  |

## Not included

`enclave token create` does not exist, deliberately. The server refuses to let an API token mint
another token, so a leaked token cannot outlive its own revocation. Mint tokens in the browser.

Generating an artifact from a prompt, and administering users, invites and the audit log, are
browser-only for now.

## Licence

Apache-2.0. Source: [github.com/datj9/enclave](https://github.com/datj9/enclave)
