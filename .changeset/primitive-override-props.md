---
'@loombox/web': patch
---

The Attention Inbox row is a real card again (background, border, hover tint) instead of bare text, and its Open trigger's title reads above the subtitle, left-aligned, instead of both centred. The onboarding "Set up this device" choice cards are left-aligned too. Both were the same bug: a CSS override handed to `Button`/`Row`/`IconButton` always lost to the primitive's own specificity and was silently discarded. `Button` gains an `align` prop (`'center'` default, `'start'` for a left-aligned, stacked label) and `Row` gains a `surface` prop (the card background/border/hover treatment) so a caller states the layout it needs instead of fighting the primitive's CSS.
