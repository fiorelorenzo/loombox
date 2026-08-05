---
'@loombox/web': patch
---

Topbar gets its v8 shape (design spec `2026-08-05-cockpit-v8-decisions.md` §3, issue #710).

C1-3: the labelled `Workbench` button (`+page.svelte`'s topbar actions) is a plain icon toggle now, in the same position and order — no `.panel-word` at any viewport width, unlike `Terminal`/`Jump to…` beside it, which keep revealing theirs at `--bp-wide`. This deliberately does only half of what Lorenzo first asked: the Files/Config/Runner group stays inside the right sidebar's own header, exactly where it already was. `cockpit-shell.spec.ts:227`'s `workbench-toggle`/`aria-pressed` assertion still holds; the specs asserting the sub-tabs live in the panel now say so as a permanent contract, not an incidental one.

D1-1: the Agent/Tracker switch moves into the topbar, centred, tied to the currently selected session's own project (mirrors `selectSession`'s own project assignment so it can't show a stale project's board just because the sidebar's "open tracker for project" menu ran more recently). `.topbar` is a real `grid-template-columns: 1fr auto 1fr` now, not the old two-zone `space-between` flex — the two flanking columns are forced to equal width by the grid algorithm, which is what keeps the centre column's midpoint pinned to the topbar's own midpoint regardless of how long the left zone's project path/title gets or how many icons the right zone carries. Verified with `getBoundingClientRect`, not a screenshot: centre-to-centre delta stays ≤2px across five widths (1024–1920px) with both a short and a deliberately long title/project/target, and while showing that session's own Tracker board.

Narrow-window answer, decided and tested: below `--bp-desktop` (1024px) the switch drops out of the topbar entirely rather than fight the truncating left zone or the rigid right one for width. It doesn't get a full-width bar of its own down there, because it isn't that width's only route — the sidebar's own `destination-tracker` row (demoted, not deleted) is already primary navigation below that breakpoint for every other destination too.

Proved the four new/rewritten `cockpit-shell.spec.ts` assertions actually exercise the fix: reverted `+page.svelte`'s half of the diff (keeping the tests) and watched all four go red — the icon-only assertion found the label still present, the two D1-1 tests couldn't find `topbar-view-switch` at all — before restoring it.
