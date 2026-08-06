#!/usr/bin/env bash
#
# The executable form of the v1 done definition: every step a stranger takes between `git clone`
# and a working, shared, then revoked artifact. If this script exits 0, self-hosting works.
#
# It fails loudly on the first broken step — there is no "continue anyway" path except the one
# documented exception below.
#
#   Exception: step 4 (generate from a prompt) needs a model provider API key. Without one the
#   step reports SKIPPED and the run continues, pushing a bundle through `POST /api/v1/artifacts`
#   instead so that steps 5-9 still exercise real artifacts. Set ANTHROPIC_API_KEY (or
#   OPENAI_API_KEY) in .env to include it.
#
# What it needs: docker, pnpm, node, curl. Nothing else, and no prior run of this project.
#
# It is safe to run repeatedly. A throwaway database (--db, default `enclave_demo`) is dropped
# and recreated on every run, because step 3 asserts that /setup is reachable exactly once, which
# is only true against an empty `users` table.
#
#   bash scripts/fresh-clone-demo.sh              # full run
#   bash scripts/fresh-clone-demo.sh --port 3100  # if 3100 is taken
#   bash scripts/fresh-clone-demo.sh --keep       # leave the server up to poke at it

set -euo pipefail

PORT=3100
DEMO_DB=enclave_demo
KEEP_SERVER=false

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --db) DEMO_DB="$2"; shift 2 ;;
    --keep) KEEP_SERVER=true; shift ;;
    -h|--help) sed -n '2,25p' "$0" | cut -c3-; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK_DIR="$(mktemp -d)"
SERVER_LOG="$WORK_DIR/server.log"
SERVER_PID=""
STEP_NUMBER=0
SKIPPED_STEPS=()

BASE_URL="http://localhost:$PORT"
ADMIN_EMAIL="admin@enclave.test"
ADMIN_PASSWORD="demo-admin-password"
MEMBER_EMAIL="member@enclave.test"
MEMBER_PASSWORD="demo-member-password"

# --- output -----------------------------------------------------------------------------------

step() { STEP_NUMBER=$((STEP_NUMBER + 1)); printf '\n=== step %d — %s\n' "$STEP_NUMBER" "$1"; }
ok() { printf '    ok    %s\n' "$1"; }
info() { printf '    ..    %s\n' "$1"; }
skipped() { SKIPPED_STEPS+=("$1"); printf '    SKIP  %s\n' "$1"; }

die() {
  printf '\nFAILED at step %d: %s\n' "$STEP_NUMBER" "$1" >&2
  if [ -s "$SERVER_LOG" ]; then
    printf '\n--- last 40 lines of the server log ---\n' >&2
    tail -40 "$SERVER_LOG" >&2
  fi
  exit 1
}

# `pnpm start` spawns `next start` as a grandchild, so killing $SERVER_PID alone leaves the
# listener holding the port and the next run silently talks to a stale server. The server is
# launched under job control (`set -m`) to get its own process group, which is what gets signalled.
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    if [ "$KEEP_SERVER" = true ]; then
      printf '\nserver left running on %s (pgid %s), log: %s\n' "$BASE_URL" "$SERVER_PID" "$SERVER_LOG"
      return
    fi
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [ "$KEEP_SERVER" = true ] || rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# --- helpers ----------------------------------------------------------------------------------

# Reads one dotted path out of a JSON document on stdin. Exits non-zero when it is absent, so
# `$(... )` under `set -e` fails the step rather than yielding an empty string.
json_field() {
  node -e '
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      let value
      try { value = JSON.parse(raw) } catch { process.exit(1) }
      for (const key of process.argv[1].split(".")) value = value?.[key]
      if (value === undefined || value === null) process.exit(1)
      process.stdout.write(String(value))
    })
  ' "$1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "\`$1\` is not on PATH. $2"
}

# Writes the response body to $WORK_DIR/body and echoes the status code.
request() {
  local method="$1" path="$2" jar="$3" body="${4-}"
  local -a args=(-s -o "$WORK_DIR/body" -w '%{http_code}' -X "$method" -H 'accept: application/json')
  [ "$jar" = "-" ] || args+=(-b "$jar" -c "$jar")
  [ -z "$body" ] || args+=(-H 'content-type: application/json' -d "$body")
  curl "${args[@]}" "$BASE_URL$path"
}

expect_status() {
  local actual="$1" expected="$2" what="$3"
  [ "$actual" = "$expected" ] || die "$what: expected HTTP $expected, got $actual — body: $(head -c 400 "$WORK_DIR/body")"
  ok "$what → $expected"
}

# --- step 1 -----------------------------------------------------------------------------------

step 'preflight: tools and .env'

require_command docker 'Install Docker Desktop or the Docker Engine.'
require_command pnpm 'Install it with `corepack enable && corepack prepare pnpm@9.15.0 --activate`.'
require_command node 'Node.js 24 or newer is required.'
require_command curl 'Install curl.'
docker compose version >/dev/null 2>&1 || die 'the `docker compose` plugin is missing.'
ok "docker $(docker --version | awk '{print $3}' | tr -d ,), pnpm $(pnpm --version), node $(node --version)"

# A listener already on $PORT would make every later assertion answer from someone else's server.
if curl -fsS -o /dev/null --max-time 2 "$BASE_URL/healthz" 2>/dev/null; then
  die "something is already serving $BASE_URL — stop it, or rerun with --port <free port>."
fi

if [ -f .env ]; then
  info '.env already exists — using it'
else
  cp .env.example .env
  ok 'copied .env.example to .env'
fi

# --- step 2 -----------------------------------------------------------------------------------

step 'bring up Postgres and MinIO, install dependencies, migrate'

docker compose --profile minio up -d postgres minio >/dev/null 2>&1 \
  || die 'docker compose could not start postgres and minio.'
ok 'compose services requested'

for attempt in $(seq 1 40); do
  if docker compose exec -T postgres pg_isready -U enclave -d enclave >/dev/null 2>&1; then break; fi
  [ "$attempt" = 40 ] && die 'Postgres never became ready. Check `docker compose logs postgres`.'
  sleep 1
done
ok 'Postgres is accepting connections on 5434'

for attempt in $(seq 1 40); do
  if curl -fsS http://localhost:9000/minio/health/live >/dev/null 2>&1; then break; fi
  [ "$attempt" = 40 ] && die 'MinIO never became ready. Check `docker compose logs minio`.'
  sleep 1
done
ok 'MinIO is answering on 9000'

# A throwaway database, so step 3 gets the empty `users` table a fresh clone would have.
docker compose exec -T postgres psql -U enclave -d enclave -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS $DEMO_DB WITH (FORCE)" -c "CREATE DATABASE $DEMO_DB" >/dev/null \
  || die "could not recreate the $DEMO_DB database."
ok "recreated the throwaway database $DEMO_DB"

# Exported, so it wins over .env everywhere: dotenv never overwrites an existing variable.
export DATABASE_URL="postgresql://enclave:enclave@localhost:5434/$DEMO_DB"
export APP_URL="$BASE_URL"
export ARTIFACT_ORIGIN_TEMPLATE="http://{id}.artifacts.localhost:$PORT"
export PORT
# NODE_ENV stays unset: `next build` and `next start` set it themselves, and exporting
# `production` here would make `pnpm install` prune the devDependencies both of them need.

pnpm install --frozen-lockfile >/dev/null 2>&1 || die 'pnpm install failed.'
ok 'dependencies installed'

pnpm db:migrate >"$WORK_DIR/migrate.log" 2>&1 || {
  tail -20 "$WORK_DIR/migrate.log" >&2
  die 'pnpm db:migrate failed.'
}
ok "applied $(ls drizzle/*.sql | wc -l | tr -d ' ') migrations"

pnpm build >"$WORK_DIR/build.log" 2>&1 || {
  tail -30 "$WORK_DIR/build.log" >&2
  die 'pnpm build failed.'
}
ok 'production build succeeded'

set -m
pnpm start >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
set +m

for attempt in $(seq 1 60); do
  if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || die 'the server exited during startup.'
  [ "$attempt" = 60 ] && die "the server never answered $BASE_URL/healthz."
  sleep 1
done
ok "server is healthy on $BASE_URL"

# --- step 3 -----------------------------------------------------------------------------------

step 'first-run setup creates the administrator, then /setup stops existing'

status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/setup")"
expect_status "$status" 200 'GET /setup on an empty instance'

ADMIN_JAR="$WORK_DIR/admin.jar"
status="$(request POST /api/setup "$ADMIN_JAR" \
  "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
expect_status "$status" 303 'POST /api/setup'
grep -q 'enclave_session' "$ADMIN_JAR" || die 'no session cookie was set for the administrator.'
ok 'administrator session cookie issued'

status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/setup")"
expect_status "$status" 404 'GET /setup once an administrator exists'

status="$(request POST /api/setup - \
  "{\"email\":\"second@enclave.test\",\"password\":\"another-long-password\"}")"
expect_status "$status" 409 'a second POST /api/setup'

# --- step 4 -----------------------------------------------------------------------------------

step 'generate an artifact from a prompt'

GENERATED_ID=""
if grep -Eq '^(ANTHROPIC_API_KEY|OPENAI_API_KEY)=.+' .env; then
  info 'a provider key is configured — calling the model'
  status="$(request POST /api/v1/generate "$ADMIN_JAR" \
    '{"prompt":"A single page that prints the numbers 1 to 5 in a list."}')"
  expect_status "$status" 200 'POST /api/v1/generate'
  GENERATED_ID="$(grep -o '"artifactId":"[^"]*"' "$WORK_DIR/body" | head -1 | cut -d'"' -f4)" \
    || die 'the stream never emitted a done event with an artifactId.'
  ok "generated artifact $GENERATED_ID"
else
  status="$(request POST /api/v1/generate "$ADMIN_JAR" '{"prompt":"anything"}')"
  expect_status "$status" 400 'POST /api/v1/generate with no provider key configured'
  code="$(json_field error.code <"$WORK_DIR/body")" || die 'the error response had no error.code.'
  [ "$code" = 'PROVIDER_KEY_INVALID' ] || die "expected PROVIDER_KEY_INVALID, got $code"
  skipped 'generation needs an API key — set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env and rerun'
  info 'the remaining steps push a bundle through POST /api/v1/artifacts instead'
fi

# --- step 5 -----------------------------------------------------------------------------------

step 'a scoped API token pushes a bundle (the public API)'

status="$(request POST /api/v1/tokens "$ADMIN_JAR" \
  '{"name":"fresh-clone-demo","scopes":["artifacts:write","artifacts:read"]}')"
expect_status "$status" 201 'POST /api/v1/tokens'
API_TOKEN="$(json_field data.token <"$WORK_DIR/body")" || die 'the token response had no data.token.'
ok 'API token issued once and never readable again'

BUNDLE="$(node -e '
  const html = "<!doctype html><title>enclave demo</title><h1>Hello from enclave</h1>" +
    "<script type=\"module\" src=\"./app.js\"></script>"
  const js = "document.title = \"enclave demo (js ran)\""
  process.stdout.write(JSON.stringify({
    title: "Fresh clone demo",
    visibility: "private",
    files: [{ path: "index.html", content: html }, { path: "app.js", content: js }],
  }))
')"

status="$(curl -s -o "$WORK_DIR/body" -w '%{http_code}' -X POST \
  -H "authorization: Bearer $API_TOKEN" -H 'content-type: application/json' \
  -d "$BUNDLE" "$BASE_URL/api/v1/artifacts")"
expect_status "$status" 201 'POST /api/v1/artifacts with a bearer token'
ARTIFACT_ID="$(json_field data.id <"$WORK_DIR/body")" || die 'the create response had no data.id.'
VERSION_ID="$(json_field data.versionId <"$WORK_DIR/body")" || die 'the create response had no data.versionId.'
ok "created artifact $ARTIFACT_ID (version $VERSION_ID)"

status="$(request POST /api/v1/tokens "$ADMIN_JAR" \
  '{"name":"fresh-clone-demo-readonly","scopes":["artifacts:read"]}')"
expect_status "$status" 201 'POST /api/v1/tokens for a read-only token'
READ_ONLY_TOKEN="$(json_field data.token <"$WORK_DIR/body")" \
  || die 'the read-only token response had no data.token.'

status="$(curl -s -o "$WORK_DIR/body" -w '%{http_code}' -X POST \
  -H "authorization: Bearer $READ_ONLY_TOKEN" -H 'content-type: application/json' \
  -d "$BUNDLE" "$BASE_URL/api/v1/artifacts")"
expect_status "$status" 403 'POST /api/v1/artifacts with an artifacts:read token'

# --- step 6 -----------------------------------------------------------------------------------

step 'the artifact renders on its own origin, behind the handoff'

ARTIFACT_HOST="$ARTIFACT_ID.artifacts.localhost:$PORT"
ARTIFACT_URL="http://$ARTIFACT_HOST"
# There is no wildcard DNS in front of this run, so curl is told where the host lives instead.
RESOLVE=(--resolve "$ARTIFACT_HOST:127.0.0.1")

curl -s -b "$ADMIN_JAR" -o "$WORK_DIR/viewer.html" -w '%{http_code}' \
  "$BASE_URL/a/$ARTIFACT_ID" >"$WORK_DIR/status"
expect_status "$(cat "$WORK_DIR/status")" 200 "GET /a/$ARTIFACT_ID as the owner"

HANDOFF="$(grep -o "__enter?t=[A-Za-z0-9._%-]*" "$WORK_DIR/viewer.html" | head -1 | cut -d= -f2)"
[ -n "$HANDOFF" ] || die 'the viewer page contained no handoff token.'
ok 'viewer page carries a single-use handoff token'

status="$(curl -s -o /dev/null -w '%{http_code}' -D "$WORK_DIR/enter.headers" \
  "${RESOLVE[@]}" "$ARTIFACT_URL/__enter?t=$HANDOFF")"
expect_status "$status" 302 'GET /__enter on the artifact origin'

# The grant cookie is Secure, and curl refuses to *store* a Secure cookie arriving over plain
# http on a non-localhost host — so it is read off the header and replayed by hand. A browser
# over https (the only supported deployment) stores it normally.
GRANT="$(sed -n 's/^[Ss]et-[Cc]ookie: enclave_grant=\([^;]*\).*/\1/p' "$WORK_DIR/enter.headers" | head -1)"
[ -n "$GRANT" ] || die 'no enclave_grant cookie was set on the artifact origin.'
ok 'grant cookie issued, scoped to this artifact origin only'

status="$(curl -s -o "$WORK_DIR/document.html" -w '%{http_code}' \
  -H "cookie: enclave_grant=$GRANT" "${RESOLVE[@]}" "$ARTIFACT_URL/")"
expect_status "$status" 200 'GET / on the artifact origin with the grant'
grep -q 'Hello from enclave' "$WORK_DIR/document.html" \
  || die 'the served document is not the bundle that was pushed.'
ok 'the entry document is the bundle, proxied through the app'

status="$(curl -s -o /dev/null -w '%{http_code}' "${RESOLVE[@]}" "$ARTIFACT_URL/")"
expect_status "$status" 404 'GET / on the artifact origin without a grant cookie'

status="$(curl -s -o /dev/null -w '%{http_code}' "${RESOLVE[@]}" \
  "$ARTIFACT_URL/__enter?t=$HANDOFF")"
expect_status "$status" 404 'replaying the same handoff token'

status="$(curl -s -o /dev/null -w '%{http_code}' -H "cookie: enclave_grant=$GRANT" \
  "${RESOLVE[@]}" "$ARTIFACT_URL/app.js")"
expect_status "$status" 302 'GET /app.js — an asset redirects to a presigned URL'

# --- step 7 -----------------------------------------------------------------------------------

step 'private means a second account cannot see it'

status="$(request POST /api/v1/invites "$ADMIN_JAR" '{"expiresInHours":1}')"
expect_status "$status" 201 'POST /api/v1/invites'
INVITE_TOKEN="$(json_field data.token <"$WORK_DIR/body")" || die 'the invite response had no data.token.'
ok 'invite issued'

MEMBER_JAR="$WORK_DIR/member.jar"
status="$(request POST /api/auth/signup "$MEMBER_JAR" \
  "{\"email\":\"$MEMBER_EMAIL\",\"password\":\"$MEMBER_PASSWORD\",\"inviteToken\":\"$INVITE_TOKEN\"}")"
expect_status "$status" 303 'POST /api/auth/signup redeeming the invite'
ok 'second account created as a member'

status="$(request POST /api/auth/signup - \
  "{\"email\":\"third@enclave.test\",\"password\":\"yet-another-password\",\"inviteToken\":\"$INVITE_TOKEN\"}")"
expect_status "$status" 410 'reusing a redeemed invite'

status="$(request GET "/api/v1/artifacts/$ARTIFACT_ID" "$MEMBER_JAR")"
expect_status "$status" 404 'the second member reading a private artifact (404, not 403)'

# --- step 8 -----------------------------------------------------------------------------------

step 'organization and public visibility, and the indexing that comes with public'

status="$(request PATCH "/api/v1/artifacts/$ARTIFACT_ID" "$ADMIN_JAR" '{"visibility":"org"}')"
expect_status "$status" 200 'PATCH visibility to org as the owner'

status="$(request GET "/api/v1/artifacts/$ARTIFACT_ID" "$MEMBER_JAR")"
expect_status "$status" 200 'the second member reading the org-visible artifact'

status="$(request PATCH "/api/v1/artifacts/$ARTIFACT_ID" "$MEMBER_JAR" '{"title":"not yours"}')"
expect_status "$status" 403 'the second member editing it'

status="$(request DELETE "/api/v1/artifacts/$ARTIFACT_ID" "$MEMBER_JAR")"
expect_status "$status" 403 'the second member deleting it'

status="$(request GET '/api/v1/audit?action=artifact.visibility_change' "$ADMIN_JAR")"
expect_status "$status" 200 'GET /api/v1/audit as the administrator'
grep -q 'artifact.visibility_change' "$WORK_DIR/body" \
  || die 'the visibility change produced no audit row.'
ok 'the visibility change is in the audit log'

# Public is the same switch one level wider: no session, no share token, no cookie jar at all.
status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/a/$ARTIFACT_ID")"
expect_status "$status" 307 'GET /a/{id} with no session while the artifact is org-visible'

status="$(request PATCH "/api/v1/artifacts/$ARTIFACT_ID" "$ADMIN_JAR" '{"visibility":"public"}')"
expect_status "$status" 200 'PATCH visibility to public as the owner'

status="$(curl -s -o "$WORK_DIR/public.html" -w '%{http_code}' "$BASE_URL/a/$ARTIFACT_ID")"
expect_status "$status" 200 'GET /a/{id} with no session once it is public'
grep -q 'content="index' "$WORK_DIR/public.html" \
  || die 'the public artifact page did not invite indexing.'
grep -q 'rel="canonical"' "$WORK_DIR/public.html" \
  || die 'the public artifact page carried no canonical URL.'
ok 'the public page is indexable and names its canonical URL'

status="$(curl -s -o "$WORK_DIR/sitemap.xml" -w '%{http_code}' "$BASE_URL/sitemap.xml")"
expect_status "$status" 200 'GET /sitemap.xml'
grep -q "$ARTIFACT_ID" "$WORK_DIR/sitemap.xml" || die 'the sitemap omitted the public artifact.'
ok 'the sitemap lists the public artifact'

status="$(request PATCH "/api/v1/artifacts/$ARTIFACT_ID" "$ADMIN_JAR" '{"visibility":"org"}')"
expect_status "$status" 200 'PATCH visibility back to org'

status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/a/$ARTIFACT_ID")"
expect_status "$status" 307 'GET /a/{id} with no session immediately after taking it back'

# --- step 9 -----------------------------------------------------------------------------------

step 'share link: works logged out, then revoke kills it'

status="$(request POST "/api/v1/artifacts/$ARTIFACT_ID/shares" "$ADMIN_JAR" \
  "{\"versionId\":\"$VERSION_ID\"}")"
expect_status "$status" 201 'POST .../shares'
SHARE_TOKEN="$(json_field data.token <"$WORK_DIR/body")" || die 'the share response had no data.token.'
SHARE_ID="$(json_field data.shareId <"$WORK_DIR/body")" || die 'the share response had no data.shareId.'
[ "${#SHARE_TOKEN}" -ge 43 ] || die "the share token is only ${#SHARE_TOKEN} characters."
ok "share token is ${#SHARE_TOKEN} characters, stored only as a hash"

status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/s/$SHARE_TOKEN")"
expect_status "$status" 200 'GET /s/{token} with no session at all'

status="$(request DELETE "/api/v1/shares/$SHARE_ID" "$ADMIN_JAR")"
expect_status "$status" 204 'DELETE /api/v1/shares/{id}'

status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/s/$SHARE_TOKEN")"
expect_status "$status" 404 'the same share URL immediately after revocation'

# --- step 10 ----------------------------------------------------------------------------------

step 'the landing page is reachable without an account'

status="$(curl -s -o "$WORK_DIR/landing.html" -w '%{http_code}' "$BASE_URL/")"
expect_status "$status" 200 'GET / unauthenticated'
grep -qi 'enclave' "$WORK_DIR/landing.html" || die 'the landing page did not render.'
ok 'landing page rendered'
info 'its design assertions are Playwright, not curl: pnpm test:e2e tests/e2e/marketing.spec.ts'

# --- summary ----------------------------------------------------------------------------------

printf '\n'
printf 'fresh-clone demo passed: %d steps\n' "$STEP_NUMBER"
if [ "${#SKIPPED_STEPS[@]}" -gt 0 ]; then
  printf '\nnot exercised by this run:\n'
  for entry in "${SKIPPED_STEPS[@]}"; do printf '  - %s\n' "$entry"; done
fi
printf '\nnext: pnpm test (unit + integration) and pnpm test:e2e (browser journeys).\n'
