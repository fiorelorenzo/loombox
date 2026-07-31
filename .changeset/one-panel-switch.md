---
'@loombox/web': patch
---

Give the topbar's controls names, and let the phone have its width back

The cockpit's topbar carried five grey icon-only buttons in a row: three that
open one drawer between three panels, one that copies the transcript, one that
opens the command palette. Nothing said the first three were the same drawer,
nothing said which one was open, and no word for any of them existed anywhere on
screen, only a `title` a pointer had to hover for and a touch device never gets.

The three panel toggles are now one bordered segmented group with a selected
segment, and each control says its name in words wherever the topbar has the
room (measured: at 1280px the whole cluster with every word visible is 344px of
a 992px topbar). Below that the words go and the accessible names stay, since
they are props on the buttons rather than the hidden spans.

Three defects came out of building it, all pre-existing:

- The Drawer, as an overlay, started at `top: 0` and covered the topbar's whole
  control cluster, backdrop included. A click aimed at the palette landed on the
  Drawer's own pin button, and the switch could not be used while a panel was
  open. It starts below the topbar now, and the backdrop dims the canvas only.
- The Drawer's header carried a second copy of the same three-way switch, also
  labelled "Panels". It states which panel is open instead, so there is one
  switch, in one place, whether the panel is open, closed, overlaid or pinned.
- The composer's text column sat 7.6px right of the transcript's: `.composer-row`
  added a `gap` on top of the same role gutter every transcript row uses, so the
  textarea began at 486.2px while the prose above it began at 493.8px.

On a phone the timeline's role column collapses and each turn's word (`YOU`,
`CLAUDE`, `TOOL`) moves above its content. That column spent 84px of a 390px
screen on a six-letter word and left the prose a 244px measure; it is 316px now.
Every surface sharing the column moves at the same breakpoint, so the timeline
keeps one left edge.

`Button` gains `pressed` (a real `aria-pressed` toggle, matching `IconButton`'s)
and `title`; `CopyButton` gains `prominent` for a standalone call site where its
half-opacity resting state read as disabled.
