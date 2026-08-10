/**
 * Per-command `--help`, keyed by exactly what `commandLabel()` produces — including a bare
 * `share`, without which `enclave share --help` would fall to the unknown-subcommand refusal.
 *
 * The facts here are read from the code, not from the README, because the terminal is the only
 * documentation a user has mid-task: bundle rules from `src/lib/bundle/rules.ts`, the 2 MB ceiling
 * and the always-ignored segments from `push-core/src/collect.ts`, host precedence and the
 * republish rules from `commands/push.ts`.
 */

const JSON_FLAG =
  '  --json       print the raw object on stdout and nothing else — for\n' +
  '               scripts, and for screen readers, which cannot follow columns\n'

const HOST_FLAGS =
  '  --host       the instance to talk to; falls back to ENCLAVE_HOST\n' +
  '  --insecure   allow an explicit http:// host that is not loopback\n'

const VERSION_HELP = `enclave version — print the CLI version

  enclave version [--json]

${JSON_FLAG}
Examples:
  enclave version
  enclave version --json
`

const LOGIN_HELP = `enclave login — store an API token for a host

  enclave login [--host <host>] [--token <token>] [--insecure]

  --token      the token to store; falls back to ENCLAVE_TOKEN, then a prompt
${HOST_FLAGS}
The token is probed against the host before it is written to
~/.config/enclave/credentials.json, which is created mode 0600. It needs all
three scopes the command prints when it starts.

Examples:
  enclave login --host enclave.example.com
  enclave login --host enclave.example.com --token <token>
`

const LOGOUT_HELP = `enclave logout — forget the stored token for a host

  enclave logout [--host <host>] [--insecure]

${HOST_FLAGS}
Only the entry for that host is removed; tokens for other hosts stay.
ENCLAVE_TOKEN is read from the environment and cannot be removed from here.

Examples:
  enclave logout --host enclave.example.com
  ENCLAVE_HOST=enclave.example.com enclave logout
`

const PUSH_HELP = `enclave push — publish a directory, or append a version to the artifact it tracks

  enclave push <dir> [--title <t>] [--visibility private|org|public]
                     [--artifact <id>] [--new] [--force] [--dry-run] [--json]
                     [--host <host>] [--insecure]

  --title      the artifact title; defaults to the name of <dir>
  --visibility private (the default), org, or public
  --artifact   append to this artifact by id, for a directory with no
               .enclave.json — a fresh CI checkout, or a wiped build output.
               A full uuid needs no lookup; a prefix of 8+ characters is
               matched against your artifacts and so also needs artifacts:read
  --new        publish a second, separate artifact from a directory that already
               has a .enclave.json
  --force      republish even when the server holds a newer version than the one
               .enclave.json records
  --dry-run    print what would be uploaded and skipped, and make no request
${JSON_FLAG}${HOST_FLAGS}
What goes up:
  index.html at the root of <dir> is required — it is the page served
  13 extensions: html css js mjs json svg png jpg jpeg webp woff2 txt md
  2 MB per file, 50 files, 10 MB in total
  node_modules, .git and every dotfile are always skipped
  .enclaveignore inside <dir> skips more: one glob per line, # comments,
    * matches within a path segment, ** crosses them, a leading / anchors

Republishing: a second push in a directory holding a .enclave.json appends a
version to the artifact it names, at the same address. It is refused when the
server has moved past the version that file records — --force publishes anyway.
Title and visibility belong to the artifact; use rename and privacy, not a push.

Host precedence: --host, then ENCLAVE_HOST, then the .enclave.json in <dir>.

Examples:
  enclave push ./dist --title "Release notes"
  enclave push ./dist
  enclave push ./dist --artifact 8aba3576 --force
  enclave push ./dist --dry-run
`

const LIST_HELP = `enclave list — list your artifacts

  enclave list [--limit <n>] [--cursor <c>] [--json] [--host <host>]
               [--insecure]

  --limit      return one page of at most n artifacts
  --cursor     start from the cursor a previous page printed
${JSON_FLAG}${HOST_FLAGS}
With neither --limit nor --cursor every page is walked. Titles wider than 40
characters are truncated; enclave show <id> prints the whole record.

Examples:
  enclave list
  enclave list --limit 20 --json
`

const SHOW_HELP = `enclave show — print one artifact in full

  enclave show <id> [--json] [--host <host>] [--insecure]

${JSON_FLAG}${HOST_FLAGS}
<id> is a full uuid, or the first 8 or more characters of one. A prefix is
matched against your own artifacts; an ambiguous one is refused, with every
candidate listed.

Examples:
  enclave show 8aba3576
  enclave show 8aba3576 --json
`

const RENAME_HELP = `enclave rename — change an artifact's title

  enclave rename <id> <title> [--json] [--host <host>] [--insecure]

${JSON_FLAG}${HOST_FLAGS}
Only the title is sent, so a rename never records a privacy change in the audit
trail. The address does not change.

Examples:
  enclave rename 8aba3576 "Q3 release notes"
  enclave rename 8aba3576 "Q3 release notes" --json
`

const PRIVACY_HELP = `enclave privacy — set who can read an artifact

  enclave privacy <id> private|org|public [--json] [--host <host>] [--insecure]

${JSON_FLAG}${HOST_FLAGS}
  private   only you
  org       everyone signed in to this instance
  public    anyone with the address, no account, and search engines may index it

To publish one pinned version behind a link you can revoke, use
enclave share create instead — that is a capability, not a visibility.

Examples:
  enclave privacy 8aba3576 org
  enclave privacy 8aba3576 private
`

const REMOVE_HELP = `enclave rm — move an artifact to the trash

  enclave rm <id> [--json] [--host <host>] [--insecure]

${JSON_FLAG}${HOST_FLAGS}
The artifact stops being readable and leaves enclave list, so the command
prints the full uuid to restore with — a trashed artifact has no prefix left
to resolve. Its share links are revoked and do not come back on restore.

Examples:
  enclave rm 8aba3576
  enclave rm 8aba3576 --json
`

const RESTORE_HELP = `enclave restore — bring an artifact back from the trash

  enclave restore <id> [--json] [--host <host>] [--insecure]

${JSON_FLAG}${HOST_FLAGS}
Takes the full uuid that enclave rm printed. Share links revoked by the delete
stay revoked; create a new one if you need it.

Examples:
  enclave restore 8aba3576-7d1e-4a5b-9c3d-0e1f2a3b4c5d
  enclave restore 8aba3576-7d1e-4a5b-9c3d-0e1f2a3b4c5d --json
`

const SHARE_HELP = `enclave share — hand out one pinned version behind a revocable link

  enclave share create <id> [--version <versionId>] [--expires <when>] [--json]
  enclave share list   <id> [--json]
  enclave share revoke <shareId>

A share link works whatever the artifact's visibility is, so revoking is the
only thing that closes it. Run enclave share create --help for --expires.

Examples:
  enclave share create 8aba3576 --expires 7d
  enclave share list 8aba3576
`

const SHARE_CREATE_HELP = `enclave share create — mint a link to one pinned version

  enclave share create <id> [--version <versionId>] [--expires <when>]
                            [--json] [--host <host>] [--insecure]

  --version    the version to pin; defaults to the current one
  --expires    when the link stops working; defaults to never
${JSON_FLAG}${HOST_FLAGS}
The URL is printed once and never again — the server keeps only its hash.

--expires takes:
  a duration          7d, 12h, 2w
  a date              2026-08-10          (local end of day, not UTC midnight)
  a date-time         2026-08-10T14:30    (this machine's local timezone)
  an ISO-8601 instant 2026-08-10T23:59:00+07:00, 2026-08-10T16:59:00Z
The resolved instant is printed in UTC and in local time before the link
is created.

Examples:
  enclave share create 8aba3576 --expires 7d
  enclave share create 8aba3576 --expires 2026-08-10T23:59:00+07:00 --json
`

const SHARE_LIST_HELP = `enclave share list — list an artifact's share links

  enclave share list <id> [--json] [--host <host>] [--insecure]

${JSON_FLAG}${HOST_FLAGS}
The link itself is never listed — it was readable once, at creation. What
is shown is the share id to revoke with, the pinned version, and the expiry.

Examples:
  enclave share list 8aba3576
  enclave share list 8aba3576 --json
`

const SHARE_REVOKE_HELP = `enclave share revoke — close a share link immediately

  enclave share revoke <shareId> [--host <host>] [--insecure]

${HOST_FLAGS}
<shareId> is the full uuid enclave share list prints, not the artifact id. The
link stops opening at once and revoking cannot be undone.

Examples:
  enclave share revoke 1d4b0f7e-2c44-4f9a-8b21-5d7e6f0a1b2c
  enclave share list 8aba3576
`

export const HELP_BY_LABEL: Readonly<Record<string, string>> = {
  version: VERSION_HELP,
  login: LOGIN_HELP,
  logout: LOGOUT_HELP,
  push: PUSH_HELP,
  list: LIST_HELP,
  show: SHOW_HELP,
  rename: RENAME_HELP,
  privacy: PRIVACY_HELP,
  rm: REMOVE_HELP,
  restore: RESTORE_HELP,
  share: SHARE_HELP,
  'share create': SHARE_CREATE_HELP,
  'share list': SHARE_LIST_HELP,
  'share revoke': SHARE_REVOKE_HELP,
}
