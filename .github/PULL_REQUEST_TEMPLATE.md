<!-- Keep this concise. The spec (SPEC.md) is the source of truth. -->

## What & why

<!-- What does this change do, and which issue does it close? -->

Closes #

## Spec / grounding

<!-- Which SPEC.md section(s) does this implement? Which SPEC §16 reference did
     you build against, if any? -->

## How I verified it

<!-- The real commands you ran and what you observed. Not just "tests pass". -->

## Checklist

- [ ] Tests ship with this change and `pnpm test` passes locally.
- [ ] `pnpm lint`, `pnpm format:check`, and `pnpm -r typecheck` pass locally.
- [ ] A changeset is included if a published package changed (`pnpm changeset`).
- [ ] **Clean-room:** no code was copied from HAPI or any AGPL/GPL source, and no
      code was copied verbatim from emdash / Happy / Nimbalyst. Design
      inspiration only.
