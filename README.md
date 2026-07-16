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

## License

MIT. See [LICENSE](LICENSE).
