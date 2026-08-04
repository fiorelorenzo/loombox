---
'@loombox/web': patch
---

Composer: drop both separators and lift the field, bigger attach glyph, Stop replaces Send with progress on the gutter

Three settled decisions from the 2026-08-04 review (v7 §1, issue #666), shipped
together because they share one strip of markup.

- **A1-3**: both of the composer's separators are gone — `.canvas-footer`'s
  `border-top` hairline and the flat rule that used to sit directly above the
  field's own border. The field keeps its border, moves to
  `--color-surface-raised`, and gains a soft `--shadow-md`, so it reads as
  floating above the page. This is deliberately the ONLY raised surface in an
  otherwise flat app — the composer is the one always-docked control surface,
  and it is allowed to be the one lifted one. Don't harmonise it back flat,
  and don't spread the shadow to another surface.
- **A2-1**: the attach glyph goes from 16px to 20px (still on `IconButton`'s
  existing hover fill). The placeholder stops teaching `@` ("Send a follow-up
  prompt…" now, was "…(type @ to reference a file)"); the `@` instruction
  moves into the hidden hint line already wired via `aria-describedby` —
  verified end to end against Chromium's own accessibility tree (CDP
  `Accessibility.getFullAXTree`), not just the DOM's `id` match.
- **A3-2**: one button in one slot. While a turn runs, Send is replaced by
  Stop (gone, not disabled-and-present) — both render at the same `Button`
  size now, so the slot's footprint never changes at the swap. The pulsing
  `StatusDot` that used to sit on the Stop button is gone too: progress now
  belongs to the turn, not the control — a live "Working…" line renders in
  `.canvas-footer` on the transcript's own `--gutter` column (reusing
  `.composer-gutter`, not a second copy of the token) whenever a turn is
  active and the transcript has no live signal of its own for it yet (i.e.
  not already covered by a streaming thought's own inline loader), and
  clears the moment the turn ends.

The composer's gutter also drops the inset accent bar it used to carry for
"your turn" (v7 §2's amended B1-2/B2-4, issue #667) — role is surface-only
now, matching every transcript row.
