---
'@loombox/web': patch
---

Give the composer a visible resting surface and a real focus ring

The composer textarea had no border, no background, no padding and no
radius (`+page.svelte:4509-4519`), and the one hairline in the whole footer
belonged to `.canvas-footer`, shared with the plan card, the queued-prompt
bar and the permission card. Against that, the composer read as plain text
run against the page background rather than an input.

Worse, it had no focus indicator at all. A comment at the old
`:4528-4531` claimed "the focus ring lives on the strip", but no
`:focus-within` rule targeting the composer existed anywhere in the file.
At-rest and focused screenshots were byte-identical (md5 match), on both
desktop and phone: clicking into the composer changed nothing on screen,
a WCAG 2.4.7 failure.

`.composer-field` (the textarea plus its controls row: attach, pickers,
the context/cost figures, Send) now carries a border, `--color-surface-raised`,
`--radius-md` and real padding, the same vocabulary `ui/TextArea` already
gives the inbox reply box and the New Session dialog fields. A
`:focus-within` rule on that same box uses the existing focus-ring token,
so the ring stays lit while the textarea, the attach button or a picker
inside the strip holds focus. Send moves from `variant="secondary"` to
`primary`, so the most-used action in the product is no longer the
quietest button on the screen.

The composer's own textarea stays borderless and transparent: its surface
is the field box around it now, and a second nested border would double
the chrome. Nothing about the docked-field layout changes, the composer
still ends the timeline aligned to the same role gutter every transcript
row uses.
