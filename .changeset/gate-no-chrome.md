---
'@loombox/web': patch
---

Take the theme toggle off the signed-out screens.

The gate shell pinned a theme control to a corner of every pre-cockpit screen
(checking session, sign-in, onboarding, `/device`). It was there on the reasoning
that a blinding light screen is hard to sign in through, but the saved preference
is already applied by the time any of those screens paint, and its default
(`system`) follows the OS, so the control changed nothing for almost everyone
while being the only button on screen that was not the point of the screen.

Appearance stays where it belongs, in the cockpit's own settings after sign-in.
