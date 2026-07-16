# loombox

A self-hosted cockpit for coding agents. Run multiple agents in parallel on machines
you control (your laptop or a remote box over SSH), each in an isolated workspace, and
watch and steer every session from a desktop browser or your phone, over a relay you
host yourself that is cryptographically unable to read your data.

> The name is the metaphor: a **loom** weaves many parallel threads into one cloth.
> loombox weaves many parallel agent sessions into one shipped product.

## Start here

This is a greenfield repo seeded from a complete, source-grounded specification produced
in a brainstorming incubator. The build is driven by the GitHub Project (milestones
v0 → v3); each issue is an agent-executable task.

- **[SPEC.md](SPEC.md)** — the full, self-contained product spec (17 sections).
- **[AGENTS.md](AGENTS.md)** — conventions for building this repo.
- **[docs/research/](docs/research/)** — the source-grounded analyses behind the spec
  (best-of teardown, gap analysis, agent-UX design, grounding audit, auth/tracker,
  cloud edition).

## What it is, in short

- A **node** daemon runs agents on **execution targets** (`local` or `ssh:<host>`) —
  local and remote, like emdash.
- A purpose-built **agent-supervisor** keeps sessions alive across disconnects (work
  continues with your PC off; resume on reopen).
- A **self-hosted relay** (Docker) that only ever sees ciphertext, plus a **web-PWA**
  for desktop and phone.
- **Per-device end-to-end encryption**; account login via OAuth (Google/GitHub, Better
  Auth) so you see synced sessions without scanning a QR every time.
- Multi-provider agents via **ACP** (Claude Code + Codex in v1), a first-class
  interaction UX (thinking, tool cards, plans, permissions), connected accounts,
  native-local or live external trackers (GitHub Issues/Projects, Jira sprints),
  integrated terminals, AI-assisted git, and image upload (local and over SSH).
- **Self-hosting is permanent and free.** A managed-cloud edition is a planned
  far-future convenience (SPEC §17), never a replacement.

## Repository layout

A pnpm monorepo (SPEC §10.1). See [AGENTS.md](AGENTS.md) for the build-convention
layer and [CONTRIBUTING.md](CONTRIBUTING.md) for the dev flow and the clean-room rule.

```
apps/web              # the web-PWA client (SvelteKit; wrapped with Capacitor for apps/mobile)
apps/mobile           # the mobile app (same PWA via Capacitor; later phase — placeholder)
packages/protocol     # the versioned Zod wire schema (shared)
packages/crypto       # E2E crypto primitives (shared)
packages/node         # the orchestrator node daemon
packages/supervisor   # the agent-supervisor (owns the ACP agent child process)
packages/relay        # the self-hostable relay (Fastify + WS + Postgres + Redis + Better Auth)
packages/providers/*  # layered ACP: core + claude / codex / generic (gemini reserved)
packages/shared       # shared types and utilities
tooling/              # shared dev config (eslint-config, ...)
scripts/              # dev/ops scripts
```

Common commands: `pnpm install`, `pnpm -r typecheck`, `pnpm lint`, `pnpm test`,
`pnpm format`. CI (`.github/workflows/ci.yml`) gates every PR on
lint + format + typecheck + test + a license scan.

## License

MIT. See [LICENSE](LICENSE). loombox is greenfield and clean-room: design
inspiration only, no vendored code, and **HAPI (AGPL-3.0) is never cloned into
this workspace**. The full policy and the AGPL-contamination process gate live in
[CONTRIBUTING.md](CONTRIBUTING.md#clean-room-rule-read-this-first).
