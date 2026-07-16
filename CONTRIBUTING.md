# Contributing to loombox

Thanks for working on loombox. This document covers the two things that are easy
to get wrong: the clean-room licensing rule and the local dev flow.

## Clean-room rule (read this first)

loombox is **greenfield and MIT-licensed** (see [LICENSE](LICENSE)). It draws
**design inspiration** from a handful of existing tools, but it imports or copies
**no code** from any of them. Reimplement; never vendor.

| Tool      | License      | What we borrow                                                                  |
| --------- | ------------ | ------------------------------------------------------------------------------- |
| emdash    | Apache-2.0   | SSH/worktree/mise-PATH mechanics; provider-agnostic ACP (design only)           |
| Happy     | MIT          | relay + PWA architecture, E2E crypto primitives, push suppression (design only) |
| Nimbalyst | MIT (client) | per-device E2E protocol shape, tracker-importer pattern (design only)           |
| **HAPI**  | **AGPL-3.0** | BYO-key voice **idea only**                                                     |

**HAPI is AGPL-3.0. This is a hard process gate:**

- **Never clone, copy, vendor, or otherwise place HAPI source in any workspace
  this repo's tooling or agents touch.** Design inspiration is fine; a local
  checkout is not.
- Do not copy code from emdash, Happy, or Nimbalyst either. Their permissive
  licenses would allow it, but the deliberate choice to reimplement keeps our
  licensing clean and avoids a permanent multi-upstream maintenance burden.
- Every dependency must be MIT/BSD/ISC/Apache-2.0-class. A CI job
  (`pnpm license:check`) fails the build if any production dependency introduces
  an AGPL/GPL-family license.
- Every pull request must tick the "no code copied from HAPI or any AGPL source"
  box in the PR template.

If you are unsure whether something crosses the line, treat it as if it does and
ask in the PR.

## Local development

Prerequisites: Node (see [.node-version](.node-version)) and
[pnpm](https://pnpm.io) 11.x. On the dev box, runtimes come from `mise`.

```bash
pnpm install            # install the whole workspace
pnpm -r typecheck       # typecheck every package
pnpm lint               # lint the whole repo
pnpm test               # run the full Vitest suite
pnpm format             # apply Prettier
```

The CI gate (`.github/workflows/ci.yml`) runs lint + format check + typecheck +
test + the license scan on every PR. Keep `main` green.

## Conventions

- **Commits:** [Conventional Commits](https://www.conventionalcommits.org/).
- **Changesets:** any change to a published package ships a changeset
  (`pnpm changeset`). See [.changeset/README.md](.changeset/README.md).
- **Tests from commit one:** every package ships tests. Vitest for unit/
  integration, Playwright for the PWA. Prefer writing the test first.
- **Spec is the source of truth:** read the relevant `SPEC.md` section(s) before
  implementing, and check `SPEC.md` §16 for the grounded reference to build
  against.
