# syntax=docker/dockerfile:1
#
# Production image for the loombox relay (#105, SPEC §5.3/§9/§10).
#
# The relay's runtime dependency tree is pure JS (fastify, @fastify/websocket,
# better-auth, pg) plus tsx (to run the TypeScript sources directly, exactly as
# `pnpm --filter @loombox/relay start` does) and the @loombox/protocol workspace
# source. The only native dependency in the monorepo, better-sqlite3, is a
# test-only devDependency, so a `--prod` install pulls no C toolchain. esbuild
# (via tsx) is prebuilt-binary only and is already allow-listed in
# pnpm-workspace.yaml's onlyBuiltDependencies, so its install runs unattended.
#
# The build context is the repo ROOT (see docker-compose) so pnpm can resolve
# the workspace:
#   docker build -f packages/relay/Dockerfile -t loombox-relay .
#
# Runtime env (see deploy/relay/.env.example): DATABASE_URL, BETTER_AUTH_SECRET,
# RELAY_PUBLIC_URL, GITHUB_CLIENT_ID/SECRET (GOOGLE_* optional).

FROM node:22-bookworm-slim
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate
WORKDIR /app

COPY . .

# Production deps for the relay and its workspace deps only (no devDependencies,
# so better-sqlite3/pg-mem/vitest are skipped and nothing is compiled).
RUN pnpm install --frozen-lockfile --prod --filter @loombox/relay...

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# main.ts self-migrates (runMigrations up) and mounts Better Auth when
# DATABASE_URL is set; the "start" script is `tsx src/main.ts`.
CMD ["pnpm", "--filter", "@loombox/relay", "start"]
