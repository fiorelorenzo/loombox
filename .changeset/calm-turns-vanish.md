---
'@loombox/web': patch
---

Turn delimitation v7 (design spec `2026-08-04-cockpit-v7-decisions.md` §2, issue #667: B1-2 amended + B2-4).

**B1-2 amended** — a user turn keeps its `--color-surface-raised` fill; an agent turn now has no fill at all and runs straight into the page background (the pre-v6 behaviour, restored on purpose); neither carries a gutter accent bar anymore — the bar the option was drawn with is gone, per Lorenzo's amendment. Exactly one signal per role, and for the agent that signal is absence.

**B2-4** — the decorative provider glyph that used to sit in the transcript's role gutter is gone. The `.sr-only` accessible role label stays on every turn (a screen reader still announces "You"/the provider name regardless), which is the whole reason this is a design choice and not an accessibility regression. `showAttribution` and the consecutive-run grouping it drove (`$lib/transcript-attribution.ts`) are removed with it — there is nothing left in the gutter for that logic to suppress.

The shared `--gutter` token (`tokens.css`) narrows from `4.75rem` to `2.5rem`: it no longer needs to fit a word or an icon, only the alignment job every sibling row (`ToolCallGutter`, `PlanCard`, `QueuedPromptBar`, the composer) still reads from `var(--gutter)`.

`MessageItem.svelte`'s "one timeline metaphor" doc comment is rewritten for this pass; thought turns are unaffected (out of scope) and keep their existing quiet `--color-surface` surface. No change to the per-row hover-revealed copy button (B3).
