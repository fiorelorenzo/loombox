@AGENTS.md

## Claude Code specific

Everything about *how to build this repo* (layout, conventions, milestones) lives in
`AGENTS.md`, imported above; the product itself is fully specified in `SPEC.md`. This
section is only for how **Claude Code** should operate here.

### Before writing code

- **Read the relevant `SPEC.md` section(s)** for the area you're touching — it is the
  source of truth. Before building any non-trivial mechanism from scratch, check
  **`SPEC.md` §16 (Grounding & references)** for the real example/reference to build
  against, and prefer that approach.
- Work from the **GitHub Project** (`loombox roadmap`, milestones v0 → v3). Take issues
  from the current milestone only; do not pull later-milestone work early. The full
  generated backlog is in `docs/backlog.json`.

### Skills to use here

- **superpowers:test-driven-development** — write the test first; every package ships
  tests from commit one (Vitest; Playwright for the PWA).
- **superpowers:systematic-debugging** — for any bug or test failure, before proposing a fix.
- **superpowers:verification-before-completion** and the **verify** / **run** skills —
  run the real commands and observe behavior before claiming an issue is done.
- **parallel-backlog-execution** — to implement several ready issues at once in isolated
  worktrees, open PRs, and merge into a green `main`.
- **product-backlog-planning** — to file the next milestone's issues from
  `docs/backlog.json` once the previous milestone is validated.

### Hard rules (worth repeating — easy to violate)

- **Clean-room.** Never clone or copy **HAPI (AGPL-3.0)** into this workspace — design
  inspiration only. Do not vendor code from emdash/Happy/Nimbalyst either; reimplement.
- **License stays MIT** for the core packages.
- Conventional Commits; keep `main` green (the CI gate is lint + typecheck + test).

### Context discipline

`SPEC.md` is large. Read the active issue's spec section(s) and the relevant package(s);
you don't need the whole spec in context every time.
