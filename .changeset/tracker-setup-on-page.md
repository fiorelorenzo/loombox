---
'@loombox/web': minor
---

Tracker page owns setup: the empty state asks, and the mode picker moves into its header

Two settled decisions from the 2026-08-04 review (spec
`2026-08-04-cockpit-v7-decisions.md` §6, F1-1/F2-2, issue #672).

**F1-1**: the Tracker page's empty state stops being blank. A project with
no tracker mode chosen yet meets the real setup step right there — native
(loombox's own local tracker) or live against a connected GitHub/Jira
account — instead of a panel with nothing in it. Connecting a GitHub or
Jira account is reachable from the same spot when none is connected yet
("Connect GitHub"/"Connect Jira" alongside the existing "use native
instead"), scoped to the session's own node.

**F2-2**: the tracker-mode picker moves out of Config and into the
Tracker page header. Once a mode is saved, the header carries a compact
badge + "Change tracker mode" control — one surface answers both "what is
this" and "change what this is". Config's Tracker section is deleted
outright, not mirrored (F2-1 was reviewed and not picked): leaving both
would reintroduce the exact two-places-for-one-fact problem this decision
exists to remove.

**A known, documented gap**: `NodeDaemon.readTrackerSnapshotForBridge`
(issue #631) reads the local native tracker unconditionally and does not
yet consult the saved mode, so a project switched to `live` still shows
local records underneath. This issue does not wait on that node-side fix;
the Tracker page names it directly (`#631`) whenever a `live` mode is
saved, rather than silently showing data that doesn't match the choice.
