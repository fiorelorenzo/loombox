---
'@loombox/web': patch
---

Give the signed-out gate a composition it never had.

Checking session, sign-in, first-run onboarding and the `/device` approval page
now share one centred layout (`GateShell`): brand lockup, tagline, then that
screen's own floating `Card`, on a low-contrast woven field, with a single theme
control in the corner.

They had no layout before. `main` was a top-aligned padded column, under a
comment claiming the pre-cockpit screens kept "the original padded, centered
column layout" when that rule had no `justify-content`, no `align-items` and no
`max-width`. So the sign-in card sat directly under the header with two thirds
of the window empty below it, and the "Checking session…" line was stranded in
the top-left corner (x=15, y=106 in a 1280x860 window) while the lockup above
it was centred: two alignment systems on one screen.

Four other things went with it:

- The brand mark was drawn twice, about 110px apart, once coloured in the
  lockup and once dimmed inside `EmptyState`. Onboarding added a third copy.
- `EmptyState` was the wrong primitive for a front door. Its documented job is
  empty sessions, empty inbox, empty targets, so it dressed the sign-in screen
  as "nothing here yet" instead of "welcome".
- The waiting weave was `WovenLoader`'s default `sm` (1em, so 12px), the size
  meant for sitting inline in a button. It is `md` now, the 2.5rem motif
  `/style-reference` documents, centred in the panel.
- The Relay URL override was a hand-rolled `<label>` plus a raw `<input>`
  beside the app's own `Field` and `Input`. It now uses those, folded into a
  disclosure so it stays available to self-hosters without competing with the
  one action everyone else is here for.

The panel keeps the same position and width in every state, so resolving the
session swaps the panel's contents without moving anything on screen. That is
covered by a Playwright spec rather than a unit test, since jsdom has no layout.

The gate's "Appearance" toggle is gone (it opened the whole accent and style
panel before the app knew who you were, and in the cockpit that lives in the
account menu). The theme toggle stays, since reading a blinding light screen
well enough to sign in is a real need.
