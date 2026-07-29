---
'@loombox/web': patch
---

Draw the sidebar's show/hide control as a panel, not a disclosure chevron.

The control that shuts the Sessions column reused `collapse-chevron`, the glyph
eight disclosure rows already use, so one mark meant two unrelated things. It
also pointed down for a column on the left, and its `scaleX(-1)` state variant
was a no-op: the chevron's path is symmetric about x=32, so both states drew an
identical glyph and the button never showed which one it was in.

It now uses a new `sidebar-panel` glyph that names the surface being toggled,
the convention in VS Code, Zed and Linear. It is deliberately never mirrored:
flipping it would move the marked column to the right, which reads as "the
panel moves to the other side" rather than "the panel is shut". State is
carried by `IconButton`'s own `aria-pressed` styling and the label, which a new
test now holds to, since they are the only things that distinguish the two
states.

The control is also always visible now, just quiet until the sidebar is hovered
or holds focus. It used to be `opacity: 0` until then, which meant the only
pointer affordance for closing the column was invisible unless you happened to
hover the header.
