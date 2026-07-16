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
  package ships tests from commit one; a GitHub Actions workflow gates merge on
  lint + typecheck + test.
- **Releases:** **Changesets** + GitHub Releases (semver + changelog).
- **Grounding:** SPEC §16 maps every non-trivial mechanism to a real reference or
  example — consult it before building a mechanism from scratch, and prefer the cited
  approach.

## Build order

Ship in milestone order — **v0** (validation spike) → **v1** (core cockpit) → **v2**
(trackers / git / editor / auth / connected accounts) → **v3** (voice / native / reach).
See SPEC §12 and the GitHub Project. Do not build later-milestone work before its
milestone.
