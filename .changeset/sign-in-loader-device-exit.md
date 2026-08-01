---
'@loombox/web': patch
---

Give the linked-device screen a way out, and the sign-in button a visible wait

Three things a real first run on a fresh dev loop turned up, all on the two
screens you meet before the cockpit.

The `/device` card ended in "you can close this tab and return to the node",
which is only true in a browser. In the desktop shell there is no tab and no
address bar, so approving a device left you looking at a screen you could not
leave, with a linked node you could not go and use. Both terminal states
(approved and denied) now end in an `Open loombox` button.

"Sign in with GitHub" gave no feedback while it worked. The click costs a round
trip to the relay before the browser leaves for GitHub, and against a hosted
relay that gap is long enough to read as a dead button, so it now shows its
`loading` state until the redirect happens (and drops back, naming the failure,
if the relay rejects the attempt).

That exposed the third: `WovenLoader` hardcoded `color: var(--color-accent)`,
which inside a filled `primary` `Button` is exactly the button's own background.
Measured on the sign-in gate: button background and all five thread strokes both
`rgb(31, 127, 208)`, so every attribute said "busy" and nothing showed on
screen. The loader takes a `tone` prop now (`accent` by default, `inherit` for a
loader inside a filled control) and `Button` passes `inherit`.
