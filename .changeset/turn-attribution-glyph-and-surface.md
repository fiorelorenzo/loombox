---
'@loombox/web': patch
---

Replace the YOU/CLAUDE/TOOL gutter words with a glyph and a surface

The transcript gutter used to hold a `--text-caption-size` uppercase word
per row — `You`, the provider's name, or `Tool` — muted further to
`opacity: 0.5` on a thought. Only the user turn got a surface of its own;
an agent turn had none at all, so a long answer ran as an unbounded stream
of prose against the page background (v6 audit finding T3), and on the
phone that prose read low-contrast enough to pass as disabled text
(finding T5).

Settled with Lorenzo 2026-08-03: attribution by surface and glyph, not by
a label. Not a colour-only rail (fails for colour-blind readers), not a
circular avatar (drags the transcript toward chat), not spacing alone.

- An agent/thought turn now draws a small decorative provider glyph
  (`icon-paths.ts`'s new `provider-claude`/`provider-codex`/`provider-gemini`/
  `provider-ohmypi`/`provider-generic` marks, sourced from `$lib/providers`'s
  existing `PROVIDER_LABELS`) and sits on its own quiet `--color-surface`,
  so it reads as a bounded block instead of loose prose.
- The user turn keeps what already worked: the raised surface and the
  gutter's accent bar. It never had a glyph and still doesn't.
- A tool call's gutter drops the "Tool" word — the tool-kind icon already
  said it, and that column was already `aria-hidden` as a whole, so
  nothing accessible is lost.
- A visually-hidden label (`.sr-only`, the same short word v5 painted
  visibly) carries the role to assistive tech on every turn, in the same
  reading-order position a sighted v5 reader's eye used to land on first.
- Consecutive turns from the same speaker (skipping over any tool calls in
  between) no longer repeat the visible glyph — `$lib/transcript-attribution.ts`'s
  `showsAttribution` decides this in `+page.svelte`'s transcript loop — but
  the accessible label and each turn's own surface never get suppressed,
  only the glyph does.
- The composer's gutter follows suit: no more caption-case "YOU", just the
  same accent bar a `user` transcript row draws on its own gutter, still
  aligned to the exact column every row shares.

Measured on the real rendered page at 390px (both themes, `--color-surface`
background against `--color-text-primary` prose): dark 15.5:1, light
17.8:1 — both well past the WCAG AA minimum of 4.5:1 for body text.
