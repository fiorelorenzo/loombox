# Opening a pull request in loombox: what the kit's skill leaves to us

The workflow kit's `pr-creation` skill (`.agents/skills/pr-creation/SKILL.md`) is the
procedure; this file is the part only this repository does. Read the skill first, then
this. Where the two disagree, this file is the more specific one and wins.

## Before you open it

Run `python3 .github/kit/bin/preflight` (or the full unscoped `pnpm lint && pnpm
format:check && pnpm -r typecheck && pnpm test`) on the final commit: it runs the checks
your diff can break, including Playwright e2e and a local desktop build, the two jobs a
PR's own CI no longer runs. See "Local verification" in `AGENTS.md`.

## The template's Clean-room and changeset section

The body has two lines under **Clean-room and changeset**, each ticked or answered with
a sentence on why it does not apply:

- A changeset is included if a published package changed (`pnpm changeset`).
- Clean-room: no code was copied from HAPI or any AGPL/GPL source, and no code was
  copied verbatim from emdash / Happy / Nimbalyst. Design inspiration only.

They are check-once facts about the diff, not narrative, so they sit between **Anything
a reviewer should look at twice** and **Screenshots** instead of in the first section.

The old template's `## Spec / grounding` section is dropped, not folded into a
conditional: describing what you built under **What this changes** is where the SPEC
section you implemented belongs, and a SPEC §16 reference you deliberately deviated from
is exactly the kind of thing **Anything a reviewer should look at twice** exists for.

## Screenshots

For anything a person could see: one before-and-after pair per change, composed into a
single side-by-side image and attached with `gh pr edit <n> --attach`. The section stays
in the body even when nothing visible changed; say so and why.

## Merging

`gh pr merge <n> --squash --delete-branch` once `ci` is green (or `--auto` right after
opening). Then `git checkout main && git reset --hard origin/main` in the main checkout,
because local `main` diverges on every squash. A push to `main` deploys the preview
(`deploy-preview.yml`, no CI gate), so read `AGENTS.md` "Merging deploys" before merging
anything that touches `apps/web`, `packages/relay` or `deploy/`.
