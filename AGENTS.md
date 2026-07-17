# AGENTS.md — building loombox

`SPEC.md` is the source of truth. **Read it fully before implementing anything.** This
file is the build-convention layer on top of it.

## Layout — a pnpm monorepo (SPEC §10.1)

- `apps/web` — the web-PWA client (**SvelteKit**, wrapped with **Capacitor** for
  `apps/mobile`; no Expo/React Native, no Tauri).
- `apps/mobile` — the mobile app (the same SvelteKit PWA via Capacitor; later phase).
- `packages/node` — the orchestrator node daemon.
- `packages/supervisor` — the agent-supervisor (owns the ACP agent as a child process
  over piped stdio; PTYs are only for the interactive terminals).
- `packages/relay` — the self-hostable relay (Fastify + WebSocket + Postgres + Redis +
  Better Auth; shipped as a Docker image + compose).
- `packages/protocol` — the versioned Zod wire schema (shared).
- `packages/crypto` — E2E crypto primitives (shared).
- `packages/providers` — layered ACP: `core` + `claude` / `codex` / `gemini`
  (reserved) + `generic` fallback.
- `packages/shared` — shared types and utilities.
- `tooling/`, `scripts/` — dev tooling and useful scripts.

The marketing landing page lives in a **separate repo** (`loombox-landing`, SvelteKit,
hosted on prodbox).

## Conventions

- **Greenfield, clean-room.** Inspired by emdash / Happy / Nimbalyst (and ACP / Zed),
  but **fork or import no code**. **HAPI is AGPL-3.0 — design inspiration only; never
  clone or copy it into this build environment** (treat this as a hard process gate).
- **License: MIT** throughout the core (SPEC §13). Only cloud-only glue (billing,
  provisioning, admin) would ever go in a separately licensed package.
- **Testing / CI:** **Vitest** (unit/integration) + **Playwright** (PWA e2e). Every
  package ships tests from commit one; the GitHub Actions workflow
  (`.github/workflows/ci.yml`) gates merge on lint + format + typecheck + test +
  a GPL/AGPL license scan. See **Local verification** below for how to run the
  minimal covering subset locally and let CI be the full gate.
- **Releases:** **Changesets** + GitHub Releases (semver + changelog).
- **Grounding:** SPEC §16 maps every non-trivial mechanism to a real reference or
  example — consult it before building a mechanism from scratch, and prefer the cited
  approach.

## Local verification: CI is the gate, run the minimal covering subset

CI (`.github/workflows/ci.yml`) runs the full `pnpm lint` + `pnpm format:check` +
`pnpm -r typecheck` + `pnpm test` + license scan on every push and PR to `main`.
That is the actual merge gate: keep `main` green and let CI run the whole matrix.
Locally, do NOT re-run the full suite for every change. Run just enough to catch
an obviously broken change in the code you touched, then rely on CI.

Scope by **amount** (narrow to your diff), never by **category**: if CI runs
typecheck + lint + format + test for a package, run all of them scoped to your
change, do not drop one because it seems slow or unrelated. That is the classic
green-locally / red-CI trap (we hit it once when a scoped Prettier glob skipped a
`.mjs` fixture that CI's full `format:check` caught).

```bash
# Tests - filter to the file(s)/pattern you touched, not the whole suite
pnpm --filter @loombox/<pkg> exec vitest run src/foo.test.ts
pnpm --filter @loombox/<pkg> exec vitest run -t "pattern"

# Typecheck - tsc is whole-project by nature; scope to the workspace(s) you touched
pnpm --filter @loombox/<pkg> typecheck

# Lint - `pnpm lint` hardcodes `.` (whole repo); call eslint directly on changed files
pnpm exec eslint packages/<pkg>/src/foo.ts

# Format - prefer the FULL `pnpm format:check` before pushing: it is cheap and
# checks every extension (incl. .mjs/.js fixtures), which a scoped .ts-only glob misses
pnpm format:check
```

Reach for the full unscoped `pnpm lint && pnpm format:check && pnpm -r typecheck &&
pnpm test` (exactly what CI runs) only right before opening or merging a PR, for a
repo-wide change, or for anything touching the wire protocol (`packages/protocol`)
or crypto (`packages/crypto`). Note: this is a private free-tier GitHub repo, so a
branch-protection rule cannot mark the check "required"; the gate is procedural,
CI runs on every PR and we never merge a red one, always via a feature branch + PR,
never a direct push to `main`.

## Build order

Ship in milestone order — **v0** (validation spike) → **v1** (core cockpit) → **v2**
(trackers / git / editor / auth / connected accounts) → **v3** (voice / native / reach).
See SPEC §12 and the GitHub Project. Do not build later-milestone work before its
milestone.
