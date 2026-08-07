---
'@loombox/web': patch
---

Migrate +page.svelte's sidebar session/destination rows onto the structural token scale (issue #605)

Pure migration, same rendered result: every hand-rolled `px`/`rem` dimension left in the sidebar's destination rows, session rows, and collapsed-rail (selvage) session avatars now reads a `styles/tokens.css` custom property instead of a literal, so this surface stops drifting from the rest of the app whenever the token scale is retuned.

- `tokens.css`: two new tokens — `--attention-dot-size` (0.4rem, the "needs attention" warning mark's diameter, previously two independent `0.4rem` literals in `+page.svelte`) and the pair `--config-popover-width`/`--config-popover-max-height` (`ConfigBar`'s compound picker popover, previously two independent `14rem` literals plus a bare `20rem` max-height).
- `+page.svelte`: `.destination-badge`, `.session-attention-dot`, `.selvage-session`'s avatar box, `.selvage-session.needs-attention::after`, and `.selvage-session :global(.selvage-status-dot)` now read the tokens above (or an existing token — `--nav-icon-size`, `--space-2xl`, `--space-3xs`) instead of a literal. `.sidebar-destinations`, `.sidebar-sessions ul`, `.session-main`, and `.project-group-sessions` each had a bare `gap: 1px`; all four now read `--space-3xs` (1.8px at the current 14.4px root), the same tightest-gap token already used for this exact purpose everywhere else in the app.
- `ConfigBar.svelte`: `.config-trigger`'s `max-width` and `.config-popover`'s `min-width`/`max-height` now read the new popover tokens.
- `PlanCard.svelte` needed no changes: every dimension in `.plan-header`/`.tool-card`/`.plan-card` already reads a token. Its `in_progress` marker's `width: 2px`/`top/bottom: 0.2em` stays a literal on purpose — it is the identical, deliberately-repeated pattern `TodoWidget.svelte` and `PlanSidebar.svelte` also carry, and migrating one of the three copies alone would fragment a shared convention rather than fix it.

Visual deltas, all sub-2px and named at the source: `.destination-badge`'s box grows 1.2rem -> 1.25rem (~0.7px). The four `gap: 1px` sites each widen to ~1.8px (~0.8px). The two `.selvage-session` offsets (`-2px` -> `calc(var(--space-3xs) * -1)`) tighten by ~0.2px. No other visible change.

Verified: `pnpm --filter @loombox/web exec vitest run src/lib/styles/tokens.test.ts src/lib/components/ConfigBar.test.ts src/lib/components/PlanCard.test.ts src/routes/page.test.ts` (223 passed), `pnpm --filter @loombox/web typecheck` (0 errors), `pnpm exec eslint` on every changed file (clean), full `pnpm format:check` (clean). Before/after screenshots at 390px and desktop against a real headless browser (seeded dev account, real session/project data) confirm the sidebar's session and destination rows render identically modulo the sub-2px deltas above.
