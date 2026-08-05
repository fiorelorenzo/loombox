---
'@loombox/web': patch
---

Thoughts and user turns get their v8 look (design spec `2026-08-05-cockpit-v8-decisions.md` §2, issue #709).

B1-1: dropped the thought's own card and italic. A thought is plain text now, a real size and colour step down from an answer (`--text-small-size`/`--color-text-secondary` instead of `opacity: 0.65; font-style: italic`), so type is the only thing marking where a thought starts or ends. The gutter column still paints nothing sighted, same as v7 left it; this isn't a licence to bring back a gutter accent bar.

B2-1: the expand/collapse choice is one preference now, not per-thought local state. `$lib/expand-thoughts.ts` stores a single boolean in `localStorage`, the same shape `$lib/accent.ts` already uses, read once on startup and applied to every thought in every session. It defaults to expanded, matching what Lorenzo actually asked for. The disclosure toggle moved above the thought and lost its "Show thought" text; it's icon-only now and carries its own `aria-label` ("Expand thought"/"Collapse thought") so the accessible name survives losing the visible text.

That preference collides with issue #660 on purpose: a thought that's actively producing text stays visible no matter what the resting preference says, so a streaming thought under a collapsed preference is never invisible until you open it and it all lands at once. Proved with a test that fails against the unfixed gate (reverted `displayExpanded`'s `|| thinking` and watched the streaming-visibility test go red before restoring it).

B3-3: the user turn's fill is `color-mix(in srgb, var(--color-accent) 8%, transparent)` instead of the flat `--color-surface-raised`, which measured three times starker in light than in dark. Verified in a real browser, both themes, against a real link and a real Send button, that 8% reads as a quiet fill rather than a clickable surface.
