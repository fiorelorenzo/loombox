---
'@loombox/web': patch
---

Move Nodes into Settings, give Settings real section navigation

Nodes & targets was a sidebar destination competing with Inbox for
attention, even though it is setup, not somewhere you go while working:
you visit it to add a target, connect a node, or find out why one is
unhealthy. It now lives inside Settings as its own section, alongside
Appearance, Notifications and Push. `sidebar-destinations` carries Inbox
alone; the mobile tabbar drops its Nodes item too.

Settings outgrew a flat `<h2>` stack once a fourth, differently-shaped
section (infrastructure with its own actions and live polling, next to
three per-device preference panels) moved in, so `SettingsPage` gets real
section navigation: a left sub-nav at `--bp-tablet` and above, a
horizontally-scrolling segmented control below it.

Two things had to survive the move rather than get dropped silently:

- The health dot `hasUnhealthyTarget` used to light on the sidebar's Nodes
  row moved onto the account-menu trigger and its "Settings" entry, so an
  unhealthy target is still visible without opening Settings. It is a
  boolean-driven dot, not an inbox item, so it can't accumulate one per
  poll and clears the moment every target recovers.
- The ⋯ "Target status" deep link (`openTargetStatus`) still lands on the
  right target, highlighted — it now switches to Settings with the Nodes
  section selected instead of its own destination.

The account-menu entry reads "Settings" instead of "Appearance &
settings", and the command palette gains "Open nodes and targets" now
that Nodes is one click deeper than before.

`docs/superpowers/specs/2026-07-25-ia-v4-design.md` gets an amendment note
recording that Nodes is no longer a primary destination, since its §3.1
listed it as one.
