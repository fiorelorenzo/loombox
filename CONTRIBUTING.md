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
- **Changesets:** any change to a released package ships a changeset
  (`pnpm changeset`). See [.changeset/README.md](.changeset/README.md) and
  [Releases](#releases) below.
- **Tests from commit one:** every package ships tests. Vitest for unit/
  integration, Playwright for the PWA. Prefer writing the test first.
- **Spec is the source of truth:** read the relevant `SPEC.md` section(s) before
  implementing, and check `SPEC.md` §16 for the grounded reference to build
  against.

## Releases

loombox uses [Changesets](https://github.com/changesets/changesets) for
per-package semver, changelogs, and GitHub Releases. **No package is published
to npm** — every package in this monorepo is `package.json`'s `"private": true`
and there is no registry configured (`access: "restricted"` in
[.changeset/config.json](.changeset/config.json) is just the safe default, it
never gets exercised). "Releasing" here means: bump versions, write
`CHANGELOG.md` entries, tag the commit, and create a GitHub Release per
package. `apps/web`, `apps/mobile`, and `tooling/eslint-config` are listed in
`.changeset/config.json`'s `ignore` array because they aren't independently
released packages.

**As a contributor:** when your change affects a released package
(`packages/*` other than `eslint-config`), run `pnpm changeset` before opening
your PR, pick the affected package(s) and a semver bump, and write a short
summary. The generated Markdown file goes in `.changeset/` and is committed
alongside your change. Purely internal changes (docs, CI/tooling, tests with
no package behavior change) don't need one.

**What happens after merge** (`.github/workflows/release.yml`, using
[changesets/action](https://github.com/changesets/action)):

1. Every push to `main` checks for pending changesets. If there are any, the
   workflow opens (or updates) a "Version Packages" PR that runs
   `pnpm version-packages` (`changeset version`): it consumes the pending
   changesets, bumps each affected package's version, writes/updates its
   `CHANGELOG.md`, and deletes the consumed changeset files.
2. Merging that PR back into `main` triggers the workflow again. This time
   there are no pending changesets, so it runs `pnpm release`
   (`changeset publish`) instead: this tags the versioned commit (per package,
   `<pkg-name>@<version>`) and skips the actual `npm publish` step because
   every package is private. `changesets/action` then pushes those tags and
   creates a GitHub Release per tag, with the changelog entry as the release
   body.

No manual version bumps or hand-written tags: the version + tag + release all
come from the changeset(s) that landed on `main`. The workflow needs
"Allow GitHub Actions to create and approve pull requests" enabled under
**Settings → Actions → General → Workflow permissions** (already on for this
repo) or it can't open the Version Packages PR.
