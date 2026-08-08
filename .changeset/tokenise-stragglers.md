---
'@loombox/web': patch
---

Tokenise the design-system stragglers: icon sizes, dialog geometry, one-off dimensions (issue #580)

Pure migration, same rendered result except for the deltas named below. Counted first per the issue's own instruction: 34 distinct value-groups migrated (42 individual CSS property replacements, counting a symmetric width/height pair as two) across 20 component files, in four complete categories — nothing left half-migrated within a category.

**Icon-size scale** — 12 call sites onto three new tokens (`em`, not `rem`, for `sm`/`md` since both size an icon sitting next to running text and are meant to track its size, same as `Icon.svelte`'s own `1em` default; `lg` is `rem` since it sizes a standalone icon box):

- `--icon-size-sm: 0.7em` — the `disclosure-icon` chevron pattern, previously six independent `0.7em` literals (`GenericToolRow`, `TargetStatusView`, `TurnEditsBar`, `BashWidget`, `EditWriteWidget`, `TodoWidget`) plus `InteractiveTerminal`'s terminal-tab close icon (`0.7rem` — proven pixel-identical: `html` sets the root font-size and nothing between it and that icon overrides it, so `em` and `rem` resolve to the same 10.08px there).
- `--icon-size-md: 0.85em` — `DirectoryPicker`'s git-badge check icon (exact) and `InteractiveTerminal`'s "new terminal" plus icon (`0.85rem`, same proof as above, exact).
- `--icon-size-lg: 1.125rem` — `CommandPalette`'s `.entry-icon` (exact) and, found while sweeping, `IconButton`'s own `md` icon box (exact) — two independently-drifting `1.125rem` literals now tied to one token.
- One real visual delta: `MessageItem`'s thought-expand chevron was `0.75em`, not `0.7em` — this file's own doc comment already calls it "the same ... disclosure chevron `GenericToolRow` uses, not a second bespoke pattern," so the mismatch was drift, not intent. Now `--icon-size-sm`. At this row's ambient 14.4px font-size: 10.8px -> 10.08px, **-0.72px**.
- Left alone, documented: `IconButton`'s compact `sm` icon (`0.8rem`, proportioned to its own 1.5rem hit target, not a scale step) and the app's separate px/unitless icon-sizing convention (`CanvasTabStrip`, `ContextLimitWarning`, `TranscriptGap`/`TranscriptRevival`, the composer's mention-pill/attach icons, `SnippetPicker`'s close icon) — a different, still-undocumented convention the issue's own examples (all em/rem) never named; flagged rather than folded in under a mismatched unit family.

**Dialog geometry** — the four compact list-picker dialogs (`CommandPalette`, `MentionPicker` — issue #580's own "FileReferencePicker.svelte" reference is stale, that component was superseded by `MentionPicker` under issue #160 — `SlashCommandPicker`, `SnippetPicker`) each override `Dialog.svelte`'s own default box and had landed on inconsistent literals. Now:

- `--dialog-width-sm: min(30rem, 92vw)` (`MentionPicker`/`SlashCommandPicker`/`SnippetPicker`, exact) and `--dialog-width-md: min(34rem, 92vw)` (`CommandPalette`, exact — it shows a shortcut/description on the same row as the label, which wants more room).
- `--dialog-max-height: 70vh`, unified on the taller of the two previously-independent values (`CommandPalette`/`SnippetPicker` were already 70vh; `MentionPicker`/`SlashCommandPicker` grow from 60vh, **+10vh**, a max-height ceiling — this can only let more content show before scrolling kicks in, never clip something that fit before).

**One-off dimensions** — the issue's explicit list, each named because it was already shared or at risk of drifting apart:

- `--status-meter-track-width: 2.5rem` / `--status-meter-track-height: 3px` — the context/cost meter track. Issue #580 names `ConfigBar.svelte:324-325`; that meter moved verbatim to `StatusBar.svelte` under issue #736 before this pass landed, so it's tokenised at its current home instead.
- `--attachment-thumb-size: 2rem` and `--attachment-chip-max-width: 16rem` — `AttachmentBar`'s preview thumbnail and chip row.
- `--diff-gutter-width: 2.5rem` and `--diff-marker-width: 1rem` — `DiffViewer`'s line-number and +/- marker columns. `--diff-gutter-width` coincidentally matches `--gutter` (the transcript's own role-alignment token) at the same 2.5rem; kept as a separate token on purpose (documented in `tokens.css`) since the two are unrelated concerns that happen to share a number today.
- `--scroll-cap-height: 12rem` — `DirectoryPicker`'s file list and `MessageItem`'s thought body, the exact duplicate literal issue #580 calls out.
- `--swatch-icon-size: 1rem`, `--swatch-size: 2.25rem`, `--swatch-check-size: 1.1rem`, `--swatch-custom-size: 1.5rem` — `AppearanceSettings`'s four swatch/checkmark sizes (theme-option icon, accent swatch, its checkmark, the custom-color preview swatch), each a genuinely different step for a different job on the same settings page.
- Checked and no longer present (refactored away since the issue was filed, nothing to migrate): `ConfigBar.svelte`'s meter (see above, moved) and `GenericToolRow.svelte`'s "timestamp min-width" — elapsed-time/cost now render through the shared `ToolCallMeta` subcomponent, which has no such min-width at all.

**Letter-spacing** — `PlanSidebar.svelte`, `TargetPicker.svelte`, and `TargetStatusView.svelte` each hand-wrote `letter-spacing: 0.02em` on an uppercase caption label, predating `--text-caption-tracking` (coherence v5, issue #508 — that token is `0.08em`). All three now read the token. Real delta at each site's ambient `--text-caption-size` (10.08px) font context: 0.2016px -> 0.8064px tracking, **+0.6px**. `InteractiveTerminal.svelte:232`, issue #580's fourth named site, has no `letter-spacing` declaration at all any more (checked; nothing to migrate there).

**The gutter** — `tokens.css`'s own `--gutter` doc comment listed every call site reading it except `TurnEditsBar.svelte`, which already does (`.turn-edits-gutter`). Added it to the list so the one place documenting "who reads this" is complete.

**Out of scope, left alone on purpose**: `Dialog.svelte`'s own default `sm`/`md`/`lg` width scale (22rem/28rem/40rem) — a working, already-consistent three-step scale for dialogs that don't override the box, unrelated to the four pickers' own override family. `GenericToolRow.svelte`'s `.entry-key { min-width: 6rem }` (a key-value list's label column, not a "timestamp" — issue #580's own line reference for that item no longer resolves to anything).

Verified: `pnpm --filter @loombox/web exec vitest run` across every changed component's own test file plus `tokens.test.ts` and `style-reference/page.test.ts` (23 files, 276 tests, all passing). `pnpm --filter @loombox/web typecheck` (1805 files, 0 errors). `pnpm exec eslint` on every changed file (clean). Full `pnpm format:check` (clean). New tokens are shown at `/style-reference` (icon-size scale, dialog geometry, and a component-dimensions list, each new section).
