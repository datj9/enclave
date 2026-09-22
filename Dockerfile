# syntax=docker/dockerfile:1

# Targets:
#   runner  (default, last stage) — the server: Next.js standalone bundle + the env preflight only.
#   tools   — full dependency tree + sources, for drizzle-kit and the scheduled jobs under scripts/.
#             Its default command applies migrations. Built straight from the context, so it does
#             not wait on `next build`.
#   migrate — alias of `tools`.
# The server image deliberately carries no drizzle-kit, tsx or dev dependencies; operator tasks
# that need them run from `tools`/`migrate`, which is never the long-running container.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `next build` evaluates route modules, so src/env.ts must not require a real environment at
# import time — it does not; validation happens on first property read.
ENV NEXT_TELEMETRY_DISABLED=1
# next.config.ts only emits `.next/standalone` when this is set; the runner stage depends on it.
ENV BUILD_STANDALONE=true
RUN pnpm build
# scripts/check-env.ts runs outside the Next bundle, and the standalone trace does not include its
# imports: Next bundles zod into server chunks rather than leaving it in node_modules, and dotenv
# is a devDependency the app never imports. Both are dependency-free, so dereferencing pnpm's
# symlinks into a flat copy is all the runner needs. If check-env.ts or src/env.ts gains an
# import, add it here.
RUN mkdir -p /preflight/node_modules \
  && cp -rL node_modules/zod node_modules/dotenv /preflight/node_modules/

# Operator toolbox. Migrations need drizzle-kit (a devDependency) and the jobs need tsx plus the
# whole server-side source graph, so this keeps the full install. It is the old runner minus the
# server bundle, plus tsconfig.json, which tsx needs to resolve the `@/*` aliases the jobs import.
FROM base AS tools
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV TZ=UTC
# Pin pnpm into an image-level cache so the non-root user never has to download it at run time.
ENV COREPACK_HOME=/corepack
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs --create-home enclave
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
COPY scripts ./scripts
RUN corepack install && chown -R enclave:nodejs "$COREPACK_HOME"
USER enclave
CMD ["pnpm", "db:migrate"]

# Alias so `--target migrate` reads as what it does; the default command above already migrates.
FROM tools AS migrate

# Kept last so a plain `docker build .` still produces the server image.
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Retention windows are exact N x 24h durations regardless of host clock, but a bare
# `new Date().toLocaleString()` would still render in the process zone if this were unset (TASK-6).
ENV TZ=UTC

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs enclave

# server.js, the traced node_modules subset and package.json (whose "type": "module" the
# preflight's type stripping relies on).
COPY --from=builder --chown=enclave:nodejs /app/.next/standalone ./
COPY --from=builder --chown=enclave:nodejs /app/.next/static ./.next/static
# There is no public/ directory today; if one is added, copy it here as well:
#   COPY --from=builder --chown=enclave:nodejs /app/public ./public

# The env preflight: check-env.ts imports only src/env.ts (zod) and dotenv.
COPY --from=builder /app/scripts/check-env.ts ./scripts/check-env.ts
COPY --from=builder /app/src/env.ts ./src/env.ts
COPY --from=builder /preflight/node_modules/ ./node_modules/

USER enclave
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The preflight runs first so a bad secret exits non-zero before server.js binds the port.
# `exec` hands PID 1 to node so it still receives SIGTERM from `docker compose down`.
CMD ["sh", "-c", "node scripts/check-env.ts && exec node server.js"]
