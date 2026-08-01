# syntax=docker/dockerfile:1

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
ENV BUILD_STANDALONE=true
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs enclave

# Migrations plus the drizzle-kit toolchain: `docker compose run --rm app pnpm db:migrate`
# is how an operator applies schema changes without a local Node install.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts

COPY --from=builder --chown=enclave:nodejs /app/.next/standalone ./
COPY --from=builder --chown=enclave:nodejs /app/.next/static ./.next/static

USER enclave
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The preflight runs first so a bad secret exits non-zero before server.js binds the port.
# `exec` hands PID 1 to node so it still receives SIGTERM from `docker compose down`.
CMD ["sh", "-c", "node scripts/check-env.ts && exec node server.js"]
